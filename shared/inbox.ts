import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { REVIEW_TOOL } from "./review";

// ---------- Config (~/.paseo/inbox.json) ----------

export const RuleSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  prompt: z.string().min(1),
  rerun: z.enum(["on-push", "once", "manual"]).default("on-push"),
  /** Globs over changed files; at least one file must match. */
  paths: z.array(z.string()).optional(),
  /** Every listed label must be on the PR. */
  labels: z.array(z.string()).optional(),
  draft: z.boolean().optional(),
  when: z.object({ checks: z.enum(["passing", "failing", "pending", "none"]).optional() }).optional(),
  /** `claude/claude-opus-5-5`, `codex/gpt-5.5`… Defaults to the config's `provider`. */
  provider: z.lazy(() => ProviderSchema).optional(),
  /** The provider's mode id. Defaults to the config's `mode`. */
  mode: z.string().optional(),
});
export type Rule = z.infer<typeof RuleSchema>;

/** A rule whose prompt asks for a review: its runs open the review screen while they're still drafting. */
export const draftsReviews = (rule: Rule) => /review/i.test(rule.prompt) || rule.prompt.includes(REVIEW_TOOL);

/** Paseo needs `provider/model`; `paseo provider models <provider>` lists the model ids. */
const ProviderSchema = z.string().regex(/^[\w-]+\/\S+$/, 'use "provider/model", e.g. "claude/claude-opus-5-5" (see `paseo provider models claude`)');

export const ConfigSchema = z.object({
  pollSeconds: z.number().int().min(60).default(300),
  maxConcurrent: z.number().int().min(1).default(2),
  provider: ProviderSchema.default("claude/claude-opus-5-5"),
  /**
   * Inbox agents run unattended, so they need a mode that doesn't stop on permission prompts.
   * GitHub writes stay blocked by the PATH guard whatever the mode. `auto` is Claude's; set Codex's own id.
   */
  mode: z.string().default("auto"),
  checkouts: z.record(z.string(), z.string()).default({}),
  sources: z.record(z.string(), z.object({ github: z.string().min(1) })).default({}),
  rules: z.array(RuleSchema).default([]),
  /** Polling and new runs stop while false; drafts already made stay readable and postable. */
  enabled: z.boolean().default(true),
  /**
   * Who may have their PR's commands run (Cerber's rules): `@login` (globs within the name),
   * `@org/team`, `@org/*`, `!` to deny. Denials win; no match means untrusted. Untrusted runs only read.
   */
  trust: z.array(z.string()).default([]),
  /** The rule a pasted PR URL runs; the first rule when unset. */
  manualRule: z.string().optional(),
});
export type Config = z.infer<typeof ConfigSchema>;
/** True when nothing is configured yet (the defaults), so a legacy inbox.json may apply instead. */
export const isUnconfigured = (config: Config) => !Object.keys(config.sources).length && !config.rules.length;

// ---------- Items and runs ----------

export const ChecksSchema = z.enum(["passing", "failing", "pending", "none"]);
export type Checks = z.infer<typeof ChecksSchema>;

export const PrSchema = z.object({
  /** `owner/repo#123`, lower-cased owner/repo. */
  key: z.string(),
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  headSha: z.string(),
  isDraft: z.boolean(),
  labels: z.array(z.string()),
  files: z.array(z.string()),
  checks: ChecksSchema,
  author: z.string().default(""),
  additions: z.number().default(0),
  deletions: z.number().default(0),
  /** GitHub's last-activity stamp: a new review request bumps it, so it gates the "asked again" check. */
  updatedAt: z.string().default(""),
});
export type Pr = z.infer<typeof PrSchema>;

export const RunStateSchema = z.enum(["queued", "running", "needs-decision", "done", "failed", "skipped", "stale", "no-checkout"]);
export type RunState = z.infer<typeof RunStateSchema>;

export const RunSchema = z.object({
  id: z.string(),
  itemKey: z.string(),
  source: z.string(),
  rule: z.string(),
  version: z.string(),
  state: RunStateSchema,
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  /** Whether the PR's author was trusted when the run started: untrusted runs only read. */
  trusted: z.boolean().optional(),
  reason: z.string().optional(),
  updatedAt: z.string(),
  /** A second (third…) run at the same head, after the review was requested again. */
  round: z.number().int().min(2).optional(),
});
export type Run = z.infer<typeof RunSchema>;

export const ItemSchema = z.object({ pr: PrSchema, sources: z.array(z.string()), lastSeenAt: z.string() });
export type Item = z.infer<typeof ItemSchema>;

export const StateSchema = z.object({ items: z.record(z.string(), ItemSchema), runs: z.array(RunSchema) });
export type State = z.infer<typeof StateSchema>;
export const emptyState = (): State => ({ items: {}, runs: [] });

/** Runs whose agent produced something for the human, or nothing yet. */
const OPEN_STATES: ReadonlySet<RunState> = new Set(["queued", "running", "needs-decision", "no-checkout"]);
/** States of runs that never started an agent, so a poll may change its mind about them. */
const REDECIDED: ReadonlySet<RunState> = new Set(["skipped", "no-checkout"]);
const KEEP_DAYS = 7;
/** States a run leaves when its PR leaves the source; a running agent finishes on its own. */
const LEAVES: ReadonlySet<RunState> = new Set(["queued", "needs-decision", "no-checkout", "skipped", "failed", "stale"]);
/** Reason on a run the human dismissed: later pushes don't queue that rule for that PR again. */
export const DISMISSED = "dismissed";

/** Why a run waits: the repo has no entry under Settings → Inbox → Repos on this machine. */
export const noCheckoutReason = (repo: string) => `no clone of ${repo} on this machine`;

export const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
export const runId = (itemKey: string, rule: string, version: string, round = 1) => `${itemKey}|${rule}|${version}${round > 1 ? `|r${round}` : ""}`;

// ---------- Matching ----------

/** Minimal glob: `**` any path, `*` any segment chars, `?` one char. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

/** Why `rule` does not apply to `pr`, or null when it does. */
export function mismatch(rule: Rule, pr: Pr): string | null {
  if (rule.draft !== undefined && pr.isDraft !== rule.draft) return rule.draft ? "not a draft" : "is a draft";
  const labels = new Set(pr.labels.map((label) => label.toLowerCase()));
  const missing = (rule.labels ?? []).filter((label) => !labels.has(label.toLowerCase()));
  if (missing.length) return `missing label ${missing.join(", ")}`;
  if (rule.when?.checks && pr.checks !== rule.when.checks) return `checks are ${pr.checks}, not ${rule.when.checks}`;
  if (rule.paths?.length) {
    const globs = rule.paths.map(globToRegExp);
    if (!pr.files.some((file) => globs.some((glob) => glob.test(file)))) return "no changed file matches its paths";
  }
  return null;
}

// ---------- Planning ----------

export interface PlanInput {
  config: Config;
  /** PRs each source returned this poll; a source that failed to poll is absent. */
  results: Record<string, Pr[]>;
  state: State;
  now: string;
}

/**
 * The next state after a poll: items refreshed, older versions of open runs marked stale, and new
 * runs added (queued, skipped, or no-checkout). Never starts anything; `startable` picks what to start.
 */
export function plan({ config, results, state, now }: PlanInput): State {
  const items: Record<string, Item> = { ...state.items };
  let runs = [...state.runs];
  const byId = new Map(runs.map((run) => [run.id, run]));
  const checkouts = new Map(Object.entries(config.checkouts).map(([repo, path]) => [repo.toLowerCase(), path]));

  const add = (run: Run) => {
    runs.push(run);
    byId.set(run.id, run);
  };

  for (const [source, prs] of Object.entries(results)) {
    const rules = config.rules.filter((rule) => rule.source === source);
    for (const pr of prs) {
      const prior = items[pr.key];
      items[pr.key] = { pr, sources: [...new Set([...(prior?.sources ?? []), source])], lastSeenAt: now };
      if (!rules.length) continue;

      const reasons: string[] = [];
      const rule = rules.find((candidate) => {
        const why = mismatch(candidate, pr);
        if (why) reasons.push(`${candidate.name}: ${why}`);
        return !why;
      });
      const ruleName = rule?.name ?? rules[0]!.name;
      const id = runId(pr.key, ruleName, pr.headSha);
      const existing = byId.get(id);
      // A run that never started is re-decided each poll: labels, checks or checkouts may have changed at the same SHA.
      if (existing && !REDECIDED.has(existing.state)) continue;

      const earlier = runs.filter((run) => run.itemKey === pr.key && run.rule === ruleName && run.version !== pr.headSha);
      runs = runs.map((run) =>
        earlier.includes(run) && OPEN_STATES.has(run.state) && run.state !== "running"
          ? { ...run, state: "stale", reason: `new push ${pr.headSha.slice(0, 7)}`, updatedAt: now }
          : run,
      );

      const base = { id, itemKey: pr.key, source, rule: ruleName, version: pr.headSha, updatedAt: now };
      let next: Run | null;
      if (!rule) next = { ...base, state: "skipped", reason: reasons.join("; ") };
      else if (dismissed(earlier)) next = null;
      else if (rule.rerun === "once" && earlier.some((run) => run.state !== "skipped" && run.state !== "no-checkout")) next = null;
      else if (rule.rerun === "manual") next = { ...base, state: "skipped", reason: "manual rule: use Run now" };
      else if (!checkouts.has(pr.repo.toLowerCase())) next = { ...base, state: "no-checkout", reason: noCheckoutReason(pr.repo) };
      else next = { ...base, state: "queued" };

      if (!next || (existing && existing.state === next.state && existing.reason === next.reason)) continue;
      const matched = next.state !== "skipped";
      // A match replaces the "no rule matched" record this version may have under another rule's name.
      runs = runs.filter((run) => run.id !== id && !(matched && run.itemKey === pr.key && run.version === pr.headSha && run.state === "skipped"));
      add(next);
    }
  }

  // A PR that left a source that did answer (reviewed on GitHub, merged, closed, label removed) has
  // nothing left to decide there: close its waiting runs so nobody posts onto a settled PR.
  for (const [source, prs] of Object.entries(results)) {
    const present = new Set(prs.map((pr) => pr.key));
    runs = runs.map((run) =>
      run.source === source && !present.has(run.itemKey) && LEAVES.has(run.state)
        ? { ...run, state: "done", reason: `no longer in ${source}: reviewed on GitHub, merged or closed`, updatedAt: now }
        : run,
    );
  }

  // A run held for a checkout starts once its repo has one, even when its source didn't return it this poll (a pasted PR's never does).
  runs = runs.map((run) => {
    const repo = items[run.itemKey]?.pr.repo.toLowerCase();
    return run.state === "no-checkout" && repo && checkouts.has(repo) ? { ...run, state: "queued", reason: undefined, updatedAt: now } : run;
  });

  // Forget items no source has returned for KEEP_DAYS, with their runs.
  const cutoff = Date.parse(now) - KEEP_DAYS * 86_400_000;
  for (const [key, item] of Object.entries(items)) if (Date.parse(item.lastSeenAt) < cutoff) delete items[key];
  runs = runs.filter((run) => items[run.itemKey]);
  return { items, runs };
}

/** The latest run that got anywhere was dismissed: a push doesn't bring it back, only being asked again does. */
function dismissed(runs: readonly Run[]): boolean {
  const latest = runs.filter((run) => run.state !== "skipped" && run.state !== "no-checkout").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return latest?.state === "done" && latest.reason === DISMISSED;
}

/** Queued runs to start now, oldest first, within `maxConcurrent`. */
export function startable(state: State, maxConcurrent: number): Run[] {
  const running = state.runs.filter((run) => run.state === "running").length;
  const room = Math.max(0, maxConcurrent - running);
  return state.runs
    .filter((run) => run.state === "queued")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(0, room);
}

export function setRun(state: State, id: string, patch: Partial<Run>, now: string): State {
  return { ...state, runs: state.runs.map((run) => (run.id === id ? { ...run, ...patch, updatedAt: now } : run)) };
}

/** The newest round of (item, rule) at `version`: 1 when there's no run yet. */
export function latestRound(state: State, itemKey: string, rule: string, version: string): number {
  return Math.max(1, ...state.runs.filter((run) => run.itemKey === itemKey && run.rule === rule && run.version === version).map((run) => run.round ?? 1));
}

/**
 * Back to queued, at the item's current version (Run now / Rerun), in the latest round there. Pass
 * `round` to start another round instead, when the latest one's review was already posted.
 */
export function requeue(state: State, config: Config, itemKey: string, rule: string, now: string, options: { round?: number; reason?: string; source?: string } = {}): State {
  const item = state.items[itemKey];
  if (!item) throw new Error(`Unknown item ${itemKey}`);
  if (!config.rules.some((candidate) => candidate.name === rule)) throw new Error(`Unknown rule ${rule}`);
  const round = options.round ?? latestRound(state, itemKey, rule, item.pr.headSha);
  const id = runId(itemKey, rule, item.pr.headSha, round);
  const current = state.runs.find((run) => run.id === id);
  if (current?.state === "running") throw new Error("Already running");
  const source = options.source ?? current?.source ?? config.rules.find((candidate) => candidate.name === rule)!.source;
  const queued: Run = { id, itemKey, source, rule, version: item.pr.headSha, state: "queued", updatedAt: now, ...(round > 1 ? { round } : {}), ...(options.reason ? { reason: options.reason } : {}) };
  return { ...state, runs: [...state.runs.filter((run) => run.id !== id), queued] };
}

// ---------- Asked again (SPEC-048 open question 2) ----------

/** The latest run of each (item, rule), whatever its round or version. */
export function latestRuns(runs: readonly Run[]): Map<string, Run> {
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const key = `${run.itemKey}|${run.rule}`;
    const seen = latest.get(key);
    if (!seen || seen.updatedAt <= run.updatedAt) latest.set(key, run);
  }
  return latest;
}

/**
 * Settled runs a new review request could reopen: the latest run of its (item, rule) is done (posted,
 * dismissed, handed off, or settled on GitHub) and the PR is back in that rule's source. Manual rules
 * only run when the human says so.
 */
export function reopenable(state: State, config: Config, results: Record<string, Pr[]>): { run: Run; pr: Pr }[] {
  const out: { run: Run; pr: Pr }[] = [];
  const latest = latestRuns(state.runs);
  for (const rule of config.rules) {
    if (rule.rerun === "manual") continue;
    for (const pr of results[rule.source] ?? []) {
      const run = latest.get(`${pr.key}|${rule.name}`);
      if (run?.state === "done") out.push({ run, pr });
    }
  }
  return out;
}

/**
 * Reopens a settled run because the human was asked to review again. An unposted draft at the head
 * comes back as it was (no AI run); otherwise a fresh run is queued at the head, in a new round when
 * this head already had one. Earlier dismissals stop counting: later pushes run as usual.
 */
export function reopen(state: State, config: Config, run: Run, ask: { at: string; by: string }, draft: { posted: boolean } | null, now: string): State {
  const item = state.items[run.itemKey];
  if (!item) return state;
  const why = `review requested again${ask.by ? ` by @${ask.by}` : ""}`;
  const head = item.pr.headSha;
  if (run.version === head && draft && !draft.posted) return setRun(state, run.id, { state: "needs-decision", reason: `${why}: your draft is back` }, now);
  const atHead = state.runs.some((candidate) => candidate.itemKey === run.itemKey && candidate.rule === run.rule && candidate.version === head);
  const round = atHead ? latestRound(state, run.itemKey, run.rule, head) + 1 : 1;
  const next = requeue(state, config, run.itemKey, run.rule, now, { round, reason: why, source: run.source });
  const checkout = Object.keys(config.checkouts).some((repo) => repo.toLowerCase() === item.pr.repo.toLowerCase());
  return checkout ? next : setRun(next, runId(run.itemKey, run.rule, head, round), { state: "no-checkout", reason: noCheckoutReason(item.pr.repo) }, now);
}

/**
 * A draft carried to a new head: the old run is done, and a run at the new head takes over its agent
 * and waits for the human. The item's head moves too, so the next poll finds the new run.
 */
export function moveRun(state: State, fromId: string, version: string, now: string): { state: State; id: string } {
  const from = state.runs.find((run) => run.id === fromId);
  if (!from) throw new Error(`Unknown run ${fromId}`);
  const id = runId(from.itemKey, from.rule, version);
  const moved: Run = { ...from, id, version, state: "needs-decision", reason: `review moved to ${version.slice(0, 7)} from ${from.version.slice(0, 7)}`, updatedAt: now };
  delete moved.round;
  const runs = state.runs.filter((run) => run.id !== id).map((run) => (run.id === fromId ? { ...run, state: "done" as const, reason: `comments moved to ${version.slice(0, 7)}`, updatedAt: now } : run));
  const item = state.items[from.itemKey];
  const items = item ? { ...state.items, [from.itemKey]: { ...item, pr: { ...item.pr, headSha: version } } } : state.items;
  return { state: { items, runs: [...runs, moved] }, id };
}

// ---------- Prompt ----------

export function preamble(pr: Pr): string {
  return [
    `You were started by paseo-inbox for ${pr.url} at ${pr.headSha}.`,
    "Do not write to GitHub: no comments, reviews, labels, pushes or merges. Those commands are blocked for you.",
    "If you were asked for a review, save it with inbox_review_draft; the human posts it from the Inbox.",
    "Otherwise end by creating one ask with your result and the exact write you propose, so the human can act on it.",
  ].join(" ");
}

export function renderPrompt(rule: Rule, pr: Pr): string {
  const values: Record<string, string> = {
    "pr.url": pr.url,
    "pr.number": String(pr.number),
    "pr.repo": pr.repo,
    "pr.title": pr.title,
    "pr.headSha": pr.headSha,
  };
  const body = rule.prompt.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => values[name] ?? match);
  return `${preamble(pr)}\n\n${body}`;
}

/** `claude/claude-opus-5-5` passes through; `claude` stays the bare provider. */
export const providerFor = (rule: Rule, config: Config) => rule.provider ?? config.provider;
export const modeFor = (rule: Rule, config: Config) => rule.mode ?? config.mode;

// ---------- RPCs ----------

const RunKeySchema = z.object({ itemKey: z.string(), rule: z.string() });

export const InboxViewSchema = z.object({
  items: z.record(z.string(), ItemSchema),
  runs: z.array(RunSchema),
  lastPollAt: z.string().nullable(),
  errors: z.array(z.string()),
  /** Rules that draft reviews (`draftsReviews`), so a running row can open the review screen before its draft exists. */
  reviewRules: z.array(z.string()).optional(),
  /** Settled runs (dismissed, stale, done) that still have a saved review draft, so they reopen it. */
  drafts: z.array(z.string()).optional(),
});
export type InboxView = z.infer<typeof InboxViewSchema>;

export const listInbox = defineRpc({ name: "inbox.list", input: z.object({}), output: InboxViewSchema });
export const runNow = defineRpc({ name: "inbox.run_now", input: RunKeySchema, output: z.object({ ok: z.literal(true) }) });
export const skipRun = defineRpc({ name: "inbox.skip", input: RunKeySchema, output: z.object({ ok: z.literal(true) }) });
/** Undo a dismissal: a dismissed run with an unposted draft goes back to needs-decision. */
export const restoreRun = defineRpc({ name: "inbox.restore", input: z.object({ runId: z.string() }), output: z.object({ ok: z.literal(true) }) });
/** Queue a review for any PR by URL (or owner/repo#123), with the manual rule. */
export const addPr = defineRpc({ name: "inbox.add_pr", input: z.object({ ref: z.string().min(1) }), output: z.object({ itemKey: z.string(), runId: z.string() }) });
/** A local clone of `repo` the inbox found on disk (origin points at it), or null. */
export const findCheckout = defineRpc({ name: "inbox.checkout_find", input: z.object({ repo: z.string() }), output: z.object({ path: z.string().nullable() }) });
/** Adds `repo → path` to the legacy inbox.json. With settings in use, the client saves settings itself (servers can't write them). */
export const addCheckout = defineRpc({ name: "inbox.checkout_add", input: z.object({ repo: z.string(), path: z.string() }), output: z.object({ ok: z.literal(true) }) });
export const pollNow = defineRpc({ name: "inbox.poll_now", input: z.object({}), output: InboxViewSchema });

// ---------- View helpers ----------

export const STATE_ORDER: RunState[] = ["needs-decision", "running", "queued", "no-checkout", "failed", "stale", "done", "skipped"];

/** Latest run per (item, rule), grouped by state in display order. */
export function groupRuns(runs: readonly Run[]): { state: RunState; runs: Run[] }[] {
  const latest = latestRuns(runs);
  return STATE_ORDER.map((state) => ({
    state,
    runs: [...latest.values()].filter((run) => run.state === state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  })).filter((group) => group.runs.length);
}

/** Rows that open the review screen: a drafted review, or a review rule's run that is still queued or drafting. */
export const opensReview = (run: Run, view: Pick<InboxView, "reviewRules" | "drafts"> | null) =>
  Boolean(run.reason?.startsWith("review ")) ||
  Boolean(view?.drafts?.includes(run.id)) ||
  ((run.state === "running" || run.state === "queued") && Boolean(view?.reviewRules?.includes(run.rule)));

/**
 * The newest run of the PR in `ref` that opens the review screen, else null. Other plugins open the
 * review screen with `{ pr: ref }` (a PR link or `owner/repo#N`), so this lookup is a public contract.
 */
export function reviewRunFor(runs: readonly Run[], view: Pick<InboxView, "reviewRules" | "drafts"> | null, ref: string): Run | null {
  const parsed = parsePrRef(ref);
  if (!parsed) return null;
  const key = prKey(parsed.repo, parsed.number);
  return runs.filter((run) => run.itemKey === key && opensReview(run, view)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** `https://github.com/o/r/pull/12` or `o/r#12` → repo and number. */
export function parsePrRef(ref: string): { repo: string; number: number } | null {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(ref);
  if (url) return { repo: url[1]!, number: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(ref.trim());
  return short ? { repo: short[1]!, number: Number(short[2]) } : null;
}

/** A PR link or `owner/repo#N` matches that PR; otherwise every term appears in its key, title, author or labels, or the run's rule or reason. */
export function matchesQuery(run: Run, pr: Pr | undefined, query: string): boolean {
  const ref = parsePrRef(query);
  if (ref) return run.itemKey === prKey(ref.repo, ref.number);
  const haystack = [run.itemKey, run.rule, run.reason, pr?.title, pr?.author, ...(pr?.labels ?? [])].filter(Boolean).join(" ").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

export const needsDecisionCount = (runs: readonly Run[]) =>
  groupRuns(runs).find((group) => group.state === "needs-decision")?.runs.length ?? 0;
