import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { parsePrRef, prKey, type Checks, type Pr, type PrOutcome } from "../shared/inbox";
import { unifiedPatch } from "../shared/linediff";

export { parsePrRef };

const exec = promisify(execFile);

// The plugin subprocess may start without the user's shell PATH; Homebrew installs gh here.
const PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

export type Gh = (args: string[]) => Promise<string>;

export const gh: Gh = async (args) => {
  const { stdout } = await exec("gh", args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH } });
  return stdout;
};

const SearchHitSchema = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  repository: z.object({ nameWithOwner: z.string() }),
  author: z.object({ login: z.string() }).nullish(),
});
type SearchHit = z.infer<typeof SearchHitSchema>;

const CheckSchema = z.object({
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
});
const DetailsSchema = z.object({
  headRefOid: z.string(),
  files: z.array(z.object({ path: z.string() })).nullish(),
  statusCheckRollup: z.array(CheckSchema).nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
});

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

/** One word for a PR's checks: any failure wins, then anything unfinished. */
export function summarizeChecks(checks: readonly z.infer<typeof CheckSchema>[]): Checks {
  if (!checks.length) return "none";
  if (checks.some((check) => FAILED.has(check.conclusion ?? "") || FAILED.has(check.state ?? ""))) return "failing";
  if (checks.some((check) => (check.status && check.status !== "COMPLETED") || check.state === "PENDING" || check.state === "EXPECTED")) return "pending";
  return "passing";
}

/** Splits a search like `is:open label:"needs qa" org:x` into gh args, keeping quoted values whole. */
export function queryArgs(query: string): string[] {
  return [...query.matchAll(/(?:[^\s"]+|"[^"]*")+/g)].map((match) => match[0].replace(/"/g, ""));
}

/**
 * PRs for one search, with head SHA, files and checks. Details are cached by URL + `updatedAt`, so
 * an unchanged PR costs one search hit and no further call.
 */
export class GithubSource {
  private readonly cache = new Map<string, { updatedAt: string; pr: Pr }>();

  constructor(private readonly run: Gh = gh) {}

  async search(query: string): Promise<Pr[]> {
    const out = await this.run(["search", "prs", ...queryArgs(query), "--json", "number,title,url,isDraft,updatedAt,labels,repository,author", "--limit", "50"]);
    const hits = z.array(SearchHitSchema).parse(JSON.parse(out));
    return Promise.all(hits.map((hit) => this.details(hit)));
  }

  /** Logins with access to the repo (for handoff suggestions); empty without permission to list them. */
  async collaborators(repo: string): Promise<string[]> {
    const lines = (out: string) => out.split("\n").map((line) => line.trim()).filter(Boolean);
    const [direct, org] = await Promise.all([
      this.run(["api", `repos/${repo}/collaborators?per_page=100`, "--jq", ".[].login"]).then(lines, () => []),
      // The repo owner's organization members (a user-owned repo just fails this and adds nobody).
      this.run(["api", `orgs/${repo.split("/")[0]}/members?per_page=100`, "--jq", ".[].login"]).then(lines, () => []),
    ]);
    return [...new Set([...direct, ...org])];
  }

  /** One PR by URL or owner/repo#n, as a source item (for a pasted link). */
  async one(ref: string): Promise<Pr> {
    const parsed = parsePrRef(ref);
    if (!parsed) throw new Error("Paste a GitHub PR link (https://github.com/owner/repo/pull/123) or owner/repo#123");
    const out = await this.run(["pr", "view", String(parsed.number), "--repo", parsed.repo, "--json", "number,title,url,isDraft,updatedAt,labels,author"]);
    const hit = z.object({ number: z.number(), title: z.string(), url: z.string(), isDraft: z.boolean(), updatedAt: z.string(), labels: z.array(z.object({ name: z.string() })), author: z.object({ login: z.string() }).nullish() }).parse(JSON.parse(out));
    return this.details({ ...hit, repository: { nameWithOwner: parsed.repo } });
  }

  private async details(hit: SearchHit): Promise<Pr> {
    const cached = this.cache.get(hit.url);
    if (cached?.updatedAt === hit.updatedAt) return cached.pr;
    const out = await this.run(["pr", "view", hit.url, "--json", "headRefOid,files,statusCheckRollup,additions,deletions"]);
    const details = DetailsSchema.parse(JSON.parse(out));
    const repo = hit.repository.nameWithOwner;
    const pr: Pr = {
      key: prKey(repo, hit.number),
      repo,
      number: hit.number,
      url: hit.url,
      title: hit.title,
      headSha: details.headRefOid,
      isDraft: hit.isDraft,
      labels: hit.labels.map((label) => label.name),
      files: (details.files ?? []).map((file) => file.path),
      checks: summarizeChecks(details.statusCheckRollup ?? []),
      author: hit.author?.login ?? "",
      additions: details.additions ?? 0,
      deletions: details.deletions ?? 0,
      updatedAt: hit.updatedAt,
    };
    this.cache.set(hit.url, { updatedAt: hit.updatedAt, pr });
    return pr;
  }
}

/** `gh <args>` with `input` on stdin; rejects with gh's stderr (GitHub's message) on failure. */
export function ghWithInput(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: { ...process.env, PATH } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `gh exited with ${code}`))));
    child.stdin.end(input);
  });
}

/** Posts a review on `owner/repo#number`; returns its URL. */
export async function postPullReview(repo: string, number: number, payload: unknown, run: (args: string[], input: string) => Promise<string> = ghWithInput): Promise<string> {
  const out = await run(["api", "--method", "POST", `repos/${repo}/pulls/${number}/reviews`, "--input", "-"], JSON.stringify(payload));
  return z.object({ html_url: z.string() }).parse(JSON.parse(out)).html_url;
}

const PullSchema = z.object({
  body: z.string().nullish(),
  user: z.object({ login: z.string() }).nullish(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string(), sha: z.string() }),
  additions: z.number(),
  deletions: z.number(),
  changed_files: z.number(),
  created_at: z.string(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  title: z.string().nullish(),
  requested_reviewers: z.array(z.object({ login: z.string() })).nullish(),
  assignees: z.array(z.object({ login: z.string() })).nullish(),
});
const ReviewCommentSchema = z.object({
  id: z.number(),
  path: z.string(),
  line: z.number().nullish(),
  original_line: z.number().nullish(),
  side: z.enum(["LEFT", "RIGHT"]).nullish(),
  user: z.object({ login: z.string() }).nullish(),
  body: z.string(),
  html_url: z.string(),
  in_reply_to_id: z.number().nullish(),
});
const FileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().nullish(),
  status: z.string(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().nullish(),
});

export type PrDetails = import("../shared/review").PrDetails;

/**
 * Description, branches and every file's patch for one PR; files are cached by head SHA (a push changes
 * them), review threads are read fresh each time (others comment without pushing).
 */
export class PrDetailsCache {
  private readonly cache = new Map<string, PrDetails["files"]>();

  constructor(private readonly run: Gh = gh) {}

  async get(repo: string, number: number): Promise<PrDetails> {
    const pull = PullSchema.parse(JSON.parse(await this.run(["api", `repos/${repo}/pulls/${number}`])));
    const key = `${repo}#${number}@${pull.head.sha}`;
    const [files, threads] = await Promise.all([this.files(repo, number, key), this.threads(repo, number)]);
    return {
      title: pull.title ?? "",
      requestedReviewers: (pull.requested_reviewers ?? []).map((user) => user.login),
      body: pull.body ?? "",
      author: pull.user?.login ?? "",
      baseRef: pull.base.ref,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      createdAt: pull.created_at,
      closedAt: pull.closed_at ?? null,
      mergedAt: pull.merged_at ?? null,
      files,
      threads,
    };
  }

  /** The PR's files at an earlier head, if this process fetched them while the PR was there. */
  cachedFiles(repo: string, number: number, sha: string): PrDetails["files"] | null {
    return this.cache.get(`${repo}#${number}@${sha}`) ?? null;
  }

  private async files(repo: string, number: number, key: string): Promise<PrDetails["files"]> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pages = await this.run(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`]);
    const files = z
      .array(z.array(FileSchema))
      .parse(JSON.parse(pages))
      .flat()
      .map(toPrFile);
    this.cache.set(key, files);
    return files;
  }

  private async threads(repo: string, number: number): Promise<PrDetails["threads"]> {
    const pages = await this.run(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/comments?per_page=100`]).catch(() => "[]");
    return z
      .array(z.array(ReviewCommentSchema))
      .parse(JSON.parse(pages))
      .flat()
      .map((comment) => ({
        id: comment.id,
        path: comment.path,
        line: comment.line ?? null,
        side: comment.side ?? "RIGHT",
        author: comment.user?.login ?? "",
        body: comment.body,
        url: comment.html_url,
        inReplyTo: comment.in_reply_to_id ?? null,
      }));
  }
}

const toPrFile = (file: z.infer<typeof FileSchema>): PrDetails["files"][number] => ({
  path: file.filename,
  previousPath: file.previous_filename ?? undefined,
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
  patch: file.patch ?? undefined,
});

const CompareSchema = z.object({
  status: z.string(),
  behind_by: z.number().default(0),
  commits: z.array(z.object({ sha: z.string(), commit: z.object({ message: z.string() }) })).default([]),
  files: z.array(FileSchema).default([]),
});

/** GitHub can't diff these two commits: one is gone (force-pushed away) or they share no history. */
const UNREACHABLE = /HTTP 404|HTTP 422|Not Found|No common ancestor/i;

/**
 * `base...head` on GitHub: status, commits and files with patches. Null when GitHub can't reach the base
 * (a force-push dropped it); other failures throw.
 */
export async function compareCommits(repo: string, base: string, head: string, run: Gh = gh): Promise<import("../shared/rereview").Compare | null> {
  let out: string;
  try {
    out = await run(["api", `repos/${repo}/compare/${base}...${head}`]);
  } catch (error) {
    const text = `${error instanceof Error ? error.message : String(error)} ${(error as { stderr?: string }).stderr ?? ""}`;
    if (UNREACHABLE.test(text)) return null;
    throw error;
  }
  const parsed = CompareSchema.parse(JSON.parse(out));
  return {
    status: parsed.status,
    behindBy: parsed.behind_by,
    commits: parsed.commits.map((commit) => ({ sha: commit.sha, message: commit.commit.message })),
    files: parsed.files.map(toPrFile),
    truncated: parsed.files.length >= COMPARE_FILE_CAP,
  };
}

/** GitHub's compare lists at most this many files. */
const COMPARE_FILE_CAP = 300;

const TreeSchema = z.object({ truncated: z.boolean(), tree: z.array(z.tuple([z.string(), z.string()])) });

/** Path → blob SHA of every file at a commit; null when GitHub cut the tree short (a very big repo). */
async function blobsAt(repo: string, sha: string, run: Gh): Promise<Map<string, string> | null> {
  const out = await run(["api", `repos/${repo}/git/trees/${sha}?recursive=1`, "--jq", '{truncated, tree: [.tree[] | select(.type == "blob") | [.path, .sha]]}']);
  const tree = TreeSchema.parse(JSON.parse(out));
  return tree.truncated ? null : new Map(tree.tree);
}

async function blobText(repo: string, sha: string, run: Gh): Promise<string> {
  const blob = z.object({ content: z.string(), encoding: z.string() }).parse(JSON.parse(await run(["api", `repos/${repo}/git/blobs/${sha}`])));
  return blob.encoding === "base64" ? Buffer.from(blob.content, "base64").toString("utf8") : blob.content;
}

/**
 * A compare that hit GitHub's 300-file cap, made whole for the PR's files: the two commits' trees say
 * exactly which files changed (and how many in all), and the PR files the compare left out get their
 * patch rebuilt from the two blobs. `totalFiles` counts as `git diff --no-renames` does (a rename is two
 * files). Null when that isn't possible (a tree GitHub cut short).
 */
export async function completeCompare(repo: string, base: string, head: string, compare: import("../shared/rereview").Compare, prPaths: ReadonlySet<string>, run: Gh = gh): Promise<import("../shared/rereview").Compare | null> {
  const [before, after] = await Promise.all([blobsAt(repo, base, run), blobsAt(repo, head, run)]);
  if (!before || !after) return null;
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
  const listed = new Map(compare.files.map((file) => [file.path, file]));
  const files: PrDetails["files"] = [];
  for (const path of changed.filter((candidate) => prPaths.has(candidate))) {
    const known = listed.get(path);
    if (known) {
      files.push(known);
      continue;
    }
    const [from, to] = [before.get(path), after.get(path)];
    const [oldText, newText] = await Promise.all([from ? blobText(repo, from, run) : "", to ? blobText(repo, to, run) : ""]);
    const status = !from ? "added" : !to ? "removed" : "modified";
    // Binary files, and ones too far apart to diff cheaply, show without a patch, as GitHub does.
    const diff = oldText.includes("\0") || newText.includes("\0") ? null : unifiedPatch(oldText, newText);
    files.push({ path, status, additions: diff?.additions ?? 0, deletions: diff?.deletions ?? 0, patch: diff?.patch || undefined });
  }
  return { ...compare, files, truncated: false, totalFiles: changed.length };
}

/** GitHub lists at most this many of a PR's commits: the oldest ones. */
const PR_COMMIT_CAP = 250;

/**
 * The PR's own commits (not the base branch's ones a merge brought in). Undefined once the list is full:
 * GitHub's 250 are the oldest, so newer commits would be missing and nothing should be filtered by it.
 */
export async function prCommits(repo: string, number: number, run: Gh = gh): Promise<Set<string> | undefined> {
  const pages = await run(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/commits?per_page=100`]);
  const shas = z.array(z.array(z.object({ sha: z.string() }))).parse(JSON.parse(pages)).flat().map((commit) => commit.sha);
  return shas.length >= PR_COMMIT_CAP ? undefined : new Set(shas);
}

const ReviewSchema = z.object({
  id: z.number(),
  user: z.object({ login: z.string() }).nullish(),
  state: z.string(),
  commit_id: z.string().nullish(),
  submitted_at: z.string().nullish(),
  html_url: z.string(),
});

type MyReview = import("../shared/rereview").MyReview;

/** Every review `me` submitted on the PR (not pending ones), newest first, with the commit each was on. */
export async function reviewsBy(repo: string, number: number, me: string, run: Gh = gh): Promise<MyReview[]> {
  const pages = await run(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/reviews?per_page=100`]);
  return z
    .array(z.array(ReviewSchema))
    .parse(JSON.parse(pages))
    .flat()
    .filter((review) => review.user?.login.toLowerCase() === me.toLowerCase() && review.state !== "PENDING" && review.commit_id && review.submitted_at)
    .sort((a, b) => Date.parse(b.submitted_at!) - Date.parse(a.submitted_at!))
    .map((review) => ({ id: String(review.id), state: review.state, commit: review.commit_id!, at: review.submitted_at!, url: review.html_url }));
}

/** The latest review `me` submitted on the PR, with the commit it was on. */
export async function latestReviewBy(repo: string, number: number, me: string, run: Gh = gh): Promise<MyReview | null> {
  return (await reviewsBy(repo, number, me, run))[0] ?? null;
}

const OutcomeSchema = z.object({
  state: z.enum(["OPEN", "MERGED", "CLOSED"]),
  latestReviews: z.array(z.object({ author: z.object({ login: z.string() }).nullish(), state: z.string(), submittedAt: z.string().nullish() })).nullish(),
});

/**
 * Where a PR stands (open, merged, closed) and whether `me` reviewed it at or after `since`: why it left
 * a source. `latestReviews` keeps each reviewer's last review however old, so a review from an earlier
 * round would otherwise read as this run's outcome.
 */
export async function prOutcome(repo: string, number: number, me: string, since?: string, run: Gh = gh): Promise<PrOutcome> {
  const out = OutcomeSchema.parse(JSON.parse(await run(["pr", "view", String(number), "--repo", repo, "--json", "state,latestReviews"])));
  const login = me.toLowerCase();
  return {
    state: out.state === "MERGED" ? "merged" : out.state === "CLOSED" ? "closed" : "open",
    reviewedByMe: Boolean(login) && (out.latestReviews ?? []).some((review) => review.author?.login.toLowerCase() === login && review.state !== "PENDING" && (!since || Boolean(review.submittedAt && Date.parse(review.submittedAt) >= Date.parse(since)))),
  };
}

const REQUESTS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    timelineItems(last: 100, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent {
      createdAt actor { login } requestedReviewer { __typename ... on User { login } }
    } } }
  } }
}`;

const RequestsSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        timelineItems: z.object({
          nodes: z.array(z.object({ createdAt: z.string(), actor: z.object({ login: z.string() }).nullish(), requestedReviewer: z.object({ __typename: z.string(), login: z.string().optional() }).nullish() }).partial()),
        }),
      }),
    }),
  }),
});

/**
 * The PR's review requests, newest 100, in one call. The re-request button looks exactly like the first
 * request everywhere else on GitHub, so the timeline is the only place that says when it was made.
 */
export async function reviewRequests(repo: string, number: number, run: Gh = gh): Promise<import("../shared/rereview").ReviewRequest[]> {
  const [owner, name] = repo.split("/");
  const out = await run(["api", "graphql", "-f", `query=${REQUESTS_QUERY}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]);
  return RequestsSchema.parse(JSON.parse(out)).data.repository.pullRequest.timelineItems.nodes.flatMap((node) =>
    node.createdAt ? [{ at: node.createdAt, reviewer: node.requestedReviewer?.__typename === "User" ? (node.requestedReviewer.login ?? null) : null, by: node.actor?.login ?? "" }] : [],
  );
}

/** Org and team membership for trust rules, cached for an hour. A failed lookup is "not a member". */
export class GithubMembership {
  private readonly cache = new Map<string, { at: number; value: boolean }>();
  constructor(private readonly run: Gh = gh) {}

  inOrg(org: string, login: string) {
    return this.cached(`org:${org}:${login}`, () => this.run(["api", `orgs/${org}/members/${login}`, "--silent"]).then(() => true));
  }

  inTeam(org: string, team: string, login: string) {
    return this.cached(`team:${org}/${team}:${login}`, () =>
      this.run(["api", `orgs/${org}/teams/${team}/memberships/${login}`]).then((out) => JSON.parse(out).state === "active"),
    );
  }

  private async cached(key: string, look: () => Promise<boolean>): Promise<boolean> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 3_600_000) return hit.value;
    const value = await look().catch(() => false);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}

/** The signed-in GitHub user. */
export async function whoami(run: Gh = gh): Promise<string> {
  return z.object({ login: z.string() }).parse(JSON.parse(await run(["api", "user"]))).login;
}
