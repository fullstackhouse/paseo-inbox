import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { prKey, type Checks, type Pr } from "../shared/inbox";

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

/** Posts a review on `owner/repo#number`; returns its URL. The plugin process isn't behind the agent write guard. */
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

/** Description, branches and every file's patch for one PR, cached by head SHA (a push changes it). */
export class PrDetailsCache {
  private readonly cache = new Map<string, PrDetails>();

  constructor(private readonly run: Gh = gh) {}

  async get(repo: string, number: number): Promise<PrDetails> {
    const pull = PullSchema.parse(JSON.parse(await this.run(["api", `repos/${repo}/pulls/${number}`])));
    const key = `${repo}#${number}@${pull.head.sha}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pages = await this.run(["api", "--paginate", "--slurp", `repos/${repo}/pulls/${number}/files?per_page=100`]);
    const files = z.array(z.array(FileSchema)).parse(JSON.parse(pages)).flat();
    const details: PrDetails = {
      body: pull.body ?? "",
      author: pull.user?.login ?? "",
      baseRef: pull.base.ref,
      headRef: pull.head.ref,
      headSha: pull.head.sha,
      additions: pull.additions,
      deletions: pull.deletions,
      changedFiles: pull.changed_files,
      createdAt: pull.created_at,
      files: files.map((file) => ({
        path: file.filename,
        previousPath: file.previous_filename ?? undefined,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        patch: file.patch ?? undefined,
      })),
    };
    this.cache.set(key, details);
    return details;
  }
}
