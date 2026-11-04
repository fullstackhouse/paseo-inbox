import { execFile } from "node:child_process";
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
    const out = await this.run(["search", "prs", ...queryArgs(query), "--json", "number,title,url,isDraft,updatedAt,labels,repository", "--limit", "50"]);
    const hits = z.array(SearchHitSchema).parse(JSON.parse(out));
    return Promise.all(hits.map((hit) => this.details(hit)));
  }

  private async details(hit: SearchHit): Promise<Pr> {
    const cached = this.cache.get(hit.url);
    if (cached?.updatedAt === hit.updatedAt) return cached.pr;
    const out = await this.run(["pr", "view", hit.url, "--json", "headRefOid,files,statusCheckRollup"]);
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
    };
    this.cache.set(hit.url, { updatedAt: hit.updatedAt, pr });
    return pr;
  }
}
