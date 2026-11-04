import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

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
});
export type Config = z.infer<typeof ConfigSchema>;

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
  reason: z.string().optional(),
  updatedAt: z.string(),
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

export const prKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
export const runId = (itemKey: string, rule: string, version: string) => `${itemKey}|${rule}|${version}`;

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
      else if (earlier.some((run) => run.state === "done" && run.reason === DISMISSED)) next = null;
      else if (rule.rerun === "once" && earlier.some((run) => run.state !== "skipped" && run.state !== "no-checkout")) next = null;
      else if (rule.rerun === "manual") next = { ...base, state: "skipped", reason: "manual rule: use Run now" };
      else if (!checkouts.has(pr.repo.toLowerCase())) next = { ...base, state: "no-checkout", reason: `set checkouts["${pr.repo}"] in inbox.json` };
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

  // Forget items no source has returned for KEEP_DAYS, with their runs.
  const cutoff = Date.parse(now) - KEEP_DAYS * 86_400_000;
  for (const [key, item] of Object.entries(items)) if (Date.parse(item.lastSeenAt) < cutoff) delete items[key];
  runs = runs.filter((run) => items[run.itemKey]);
  return { items, runs };
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

/** Back to queued, at the item's current version (Run now / Rerun). */
export function requeue(state: State, config: Config, itemKey: string, rule: string, now: string): State {
  const item = state.items[itemKey];
  if (!item) throw new Error(`Unknown item ${itemKey}`);
  if (!config.rules.some((candidate) => candidate.name === rule)) throw new Error(`Unknown rule ${rule}`);
  const id = runId(itemKey, rule, item.pr.headSha);
  const current = state.runs.find((run) => run.id === id);
  if (current?.state === "running") throw new Error("Already running");
  const source = current?.source ?? config.rules.find((candidate) => candidate.name === rule)!.source;
  const queued: Run = { id, itemKey, source, rule, version: item.pr.headSha, state: "queued", updatedAt: now };
  return { ...state, runs: [...state.runs.filter((run) => run.id !== id), queued] };
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
});
export type InboxView = z.infer<typeof InboxViewSchema>;

export const listInbox = defineRpc({ name: "inbox.list", input: z.object({}), output: InboxViewSchema });
export const runNow = defineRpc({ name: "inbox.run_now", input: RunKeySchema, output: z.object({ ok: z.literal(true) }) });
export const skipRun = defineRpc({ name: "inbox.skip", input: RunKeySchema, output: z.object({ ok: z.literal(true) }) });
export const pollNow = defineRpc({ name: "inbox.poll_now", input: z.object({}), output: InboxViewSchema });

// ---------- View helpers ----------

export const STATE_ORDER: RunState[] = ["needs-decision", "running", "queued", "no-checkout", "failed", "stale", "done", "skipped"];

/** Latest run per (item, rule), grouped by state in display order. */
export function groupRuns(runs: readonly Run[]): { state: RunState; runs: Run[] }[] {
  const latest = new Map<string, Run>();
  for (const run of runs) {
    const key = `${run.itemKey}|${run.rule}`;
    const seen = latest.get(key);
    if (!seen || seen.updatedAt <= run.updatedAt) latest.set(key, run);
  }
  return STATE_ORDER.map((state) => ({
    state,
    runs: [...latest.values()].filter((run) => run.state === state).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  })).filter((group) => group.runs.length);
}

export const needsDecisionCount = (runs: readonly Run[]) =>
  groupRuns(runs).find((group) => group.state === "needs-decision")?.runs.length ?? 0;
