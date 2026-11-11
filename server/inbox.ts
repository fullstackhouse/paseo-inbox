import { DISMISSED, draftsReviews, latestRound, modeFor, moveRun, noCheckoutReason, plan, renderPrompt, providerFor, reopen, reopenable, requeue, runId, setRun, startable, type Config, type InboxView, type Pr, type Run, type State } from "../shared/inbox";
import { askedAgain, type ReviewRequest } from "../shared/rereview";
import type { Verdict } from "../shared/review";

/** At most this many "asked again?" timeline reads per poll. */
const REOPEN_CHECKS = 10;
const SETTLED: ReadonlySet<Run["state"]> = new Set(["done", "stale", "failed"]);

export interface StartRequest {
  run: Run;
  pr: Pr;
  cwd: string;
  provider: string;
  mode: string;
  prompt: string;
  /** Untrusted runs only read: no commands, no edits, no GitHub or git credentials. */
  trusted: boolean;
}

export interface InboxDeps {
  loadConfig: () => Config | null;
  search: (query: string) => Promise<Pr[]>;
  start: (request: StartRequest) => Promise<{ agentId: string; workspaceId?: string | null }>;
  load: () => State;
  save: (state: State) => void;
  /** Whether the PR's author is on the trust list; untrusted when absent. */
  trust?: (pr: Pr, config: Config) => Promise<{ trusted: boolean; because: string }>;
  /** Tells the reviewer agent's chat a draft is ready (the "Open review" card). */
  announce?: (run: Run, headline: string) => Promise<void>;
  /**
   * Tells the human a run's turn ended without a draft (completed or failed; not canceled). The
   * agent's own "finished" notification is muted while its workspace is in the background.
   */
  ended?: (run: Run) => Promise<void>;
  /** Archives an inbox agent's workspace (and its worktree) once the human is done with it. */
  archive?: (workspaceId: string) => Promise<void>;
  /** The PR's review requests (GitHub timeline), for reopening a settled run when the human is asked again. */
  requests?: (pr: Pr) => Promise<ReviewRequest[]>;
  /** The signed-in GitHub login. */
  me?: () => Promise<string>;
  /** A run's review draft: whether it was posted, and the verdict it posts as. */
  draftOf?: (runId: string) => { posted: boolean; verdict: Verdict } | null;
  /** Whether a run has a review draft on disk; cheaper than `draftOf`, asked on every list. */
  hasDraft?: (runId: string) => boolean;
  /** Moves a run's (background) workspace into the sidebar, once the human works in it. */
  reveal?: (workspaceId: string) => Promise<void>;
  /** False until the plugin has a Paseo session to create agents with; queued runs wait. */
  ready?: () => boolean;
  now?: () => string;
}

/** The inbox loop: poll sources, plan runs, start what fits, and track agents to their outcome. */
export class Inbox {
  private state: State;
  private lastPollAt: string | null = null;
  private errors: string[] = [];
  private polling: Promise<void> | null = null;
  /** Per settled run: the PR's `updatedAt` when it was last checked for a new request. A request bumps it. */
  private readonly checked = new Map<string, string>();
  private readonly now: () => string;

  constructor(private readonly deps: InboxDeps) {
    this.state = deps.load();
    this.now = deps.now ?? (() => new Date().toISOString());
    // Agents that were running when the plugin stopped can't be tracked from here; let the human decide.
    for (const run of this.state.runs.filter((candidate) => candidate.state === "running")) {
      this.commit(setRun(this.state, run.id, { state: "needs-decision", reason: "plugin restarted while it ran" }, this.now()));
    }
  }

  view(): InboxView {
    return { items: this.state.items, runs: this.state.runs, lastPollAt: this.lastPollAt, errors: this.errors, reviewRules: this.reviewRules(), drafts: this.settledDrafts(), postable: this.postable() };
  }

  /**
   * Runs waiting on the human with a draft, and the verdict it posts as. Posting settles the run and a
   * push marks it stale, so both drop out; `postDraft` still refuses a posted or stale draft.
   */
  private postable(): Record<string, Verdict> {
    const draftOf = this.deps.draftOf;
    if (!draftOf) return {};
    const postable: Record<string, Verdict> = {};
    for (const run of this.state.runs) {
      if (run.state !== "needs-decision") continue;
      const draft = draftOf(run.id);
      if (draft) postable[run.id] = draft.verdict;
    }
    return postable;
  }

  /** Settled runs whose reason no longer says "review …" (dismissed, stale, done) but whose draft is still saved. */
  private settledDrafts(): string[] {
    const hasDraft = this.deps.hasDraft;
    if (!hasDraft) return [];
    return this.state.runs.filter((run) => SETTLED.has(run.state) && !run.reason?.startsWith("review ") && hasDraft(run.id)).map((run) => run.id);
  }

  /** An invalid config already shows in `errors`; it just means no row opens the review screen early. */
  private reviewRules(): string[] {
    try {
      return this.deps.loadConfig()?.rules.filter(draftsReviews).map((rule) => rule.name) ?? [];
    } catch {
      return [];
    }
  }

  isInboxAgent(agentId: string): boolean {
    return this.state.runs.some((run) => run.agentId === agentId);
  }

  /** One poll; concurrent callers share it. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const errors: string[] = [];
    let config: Config | null;
    try {
      config = this.deps.loadConfig();
    } catch (error) {
      this.errors = [`inbox.json is invalid: ${message(error)}`];
      return;
    }
    if (!config) {
      this.errors = ["Nothing configured yet: open Settings → Inbox to add sources and rules."];
      return;
    }
    if (!config.enabled) {
      this.errors = ["Paused in Settings → Inbox."];
      return;
    }
    const results: Record<string, Pr[]> = {};
    await Promise.all(
      Object.entries(config.sources).map(async ([name, source]) => {
        try {
          results[name] = await this.deps.search(source.github);
        } catch (error) {
          errors.push(`${name}: ${message(error)}`);
        }
      }),
    );
    this.commit(plan({ config, results, state: this.state, now: this.now() }));
    await this.reopenAsked(config, results);
    this.lastPollAt = this.now();
    this.errors = errors;
    await this.dispatch(config);
  }

  /**
   * SPEC-048 open question 2: a settled run (posted, dismissed, handed off) reopens when GitHub's timeline
   * shows the human was asked to review again after it settled. Only PRs that changed since the last
   * check cost a call, and a failed read changes nothing.
   */
  private async reopenAsked(config: Config, results: Record<string, Pr[]>): Promise<void> {
    if (!this.deps.requests || !this.deps.me) return;
    const due = reopenable(this.state, config, results).filter(({ run, pr }) => this.checked.get(run.id) !== pr.updatedAt || !pr.updatedAt);
    if (!due.length) return;
    const me = await this.deps.me().catch(() => "");
    if (!me) return;
    for (const { run, pr } of due.slice(0, REOPEN_CHECKS)) {
      // Spent before the call, so an outage doesn't turn into a retry on every poll.
      this.checked.set(run.id, pr.updatedAt);
      try {
        const ask = askedAgain(await this.deps.requests(pr), me, run.updatedAt);
        const current = this.run(run.id);
        if (!ask || current?.state !== "done" || current.updatedAt !== run.updatedAt) continue;
        console.log(`inbox: ${run.itemKey} reopened, review requested again by @${ask.by} at ${ask.at}`);
        this.commit(reopen(this.state, config, current, ask, this.deps.draftOf?.(run.id) ?? null, this.now()));
      } catch (error) {
        console.error("inbox: review-request check failed", run.itemKey, message(error));
      }
    }
  }

  private async dispatch(config: Config): Promise<void> {
    if (this.deps.ready && !this.deps.ready()) return;
    // Re-pick after each start: a run that fails to start frees its slot for the next queued one.
    const tried = new Set<string>();
    for (let run = startable(this.state, config.maxConcurrent).find((candidate) => !tried.has(candidate.id)); run; run = startable(this.state, config.maxConcurrent).find((candidate) => !tried.has(candidate.id))) {
      tried.add(run.id);
      // Another dispatch may have taken it while this one awaited.
      if (this.state.runs.find((candidate) => candidate.id === run.id)?.state !== "queued") continue;
      if (this.state.runs.filter((candidate) => candidate.state === "running").length >= config.maxConcurrent) break;
      const pr = this.state.items[run.itemKey]?.pr;
      const rule = config.rules.find((candidate) => candidate.name === run.rule);
      const cwd = pr && Object.entries(config.checkouts).find(([repo]) => repo.toLowerCase() === pr.repo.toLowerCase())?.[1];
      if (!pr || !rule || !cwd) {
        this.commit(setRun(this.state, run.id, { state: "failed", reason: !rule ? "rule removed from inbox.json" : "no checkout" }, this.now()));
        continue;
      }
      this.commit(setRun(this.state, run.id, { state: "running", reason: undefined }, this.now()));
      try {
        const trust = this.deps.trust ? await this.deps.trust(pr, config) : { trusted: false, because: "no trust check" };
        const started = await this.deps.start({ run, pr, cwd, provider: providerFor(rule, config), mode: modeFor(rule, config), prompt: renderPrompt(rule, pr), trusted: trust.trusted });
        this.commit(setRun(this.state, run.id, { agentId: started.agentId, workspaceId: started.workspaceId ?? undefined, trusted: trust.trusted, reason: trust.trusted ? undefined : `read-only run: ${trust.because}` }, this.now()));
      } catch (error) {
        // A rate limit passes on its own: keep the run queued for the next poll instead of failing it.
        const limited = /rate limit/i.test(message(error));
        const patch: Partial<Run> = limited
          ? { state: "queued", reason: "GitHub rate limit; retrying on the next poll" }
          : { state: "failed", reason: `could not start the agent: ${message(error)}` };
        this.commit(setRun(this.state, run.id, patch, this.now()));
        if (limited) break;
      }
    }
  }

  /** The agent's first turn ended: completed means a result waits for the human. */
  turnEnded(agentId: string, outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string }): void {
    const run = this.state.runs.find((candidate) => candidate.agentId === agentId && candidate.state === "running");
    if (!run) return;
    const patch: Partial<Run> =
      outcome.kind === "completed"
        ? { state: "needs-decision" }
        : { state: "failed", reason: outcome.kind === "failed" ? outcome.error.message : `canceled: ${outcome.reason}` };
    this.commit(setRun(this.state, run.id, patch, this.now()));
    const ended = this.state.runs.find((candidate) => candidate.id === run.id);
    if (ended && outcome.kind !== "canceled") void this.deps.ended?.(ended).catch(() => undefined);
    void this.afterChange();
  }

  /**
   * A turn after the run's own: the human took over (a message, an ask's Send, "Ask about this"),
   * so its workspace leaves the background and shows in the sidebar.
   */
  turnStarted(agentId: string): void {
    const run = this.runForAgent(agentId);
    if (!run?.workspaceId || run.state === "running") return;
    const { workspaceId } = run;
    void this.deps.reveal?.(workspaceId).catch((error) => console.error("reveal failed", workspaceId, error));
  }

  agentGone(agentId: string): void {
    const run = this.state.runs.find((candidate) => candidate.agentId === agentId && candidate.state === "running");
    if (!run) return;
    this.commit(setRun(this.state, run.id, { state: "failed", reason: "agent closed before it finished" }, this.now()));
    void this.afterChange();
  }

  async runNow(itemKey: string, rule: string): Promise<void> {
    const config = this.deps.loadConfig();
    if (!config) throw new Error("No inbox.json");
    // A review already posted at this head can't be replaced: drafting again starts another round.
    const head = this.state.items[itemKey]?.pr.headSha;
    const round = head ? latestRound(this.state, itemKey, rule, head) : 1;
    const posted = head ? this.deps.draftOf?.(runId(itemKey, rule, head, round))?.posted : false;
    this.commit(requeue(this.state, config, itemKey, rule, this.now(), posted ? { round: round + 1 } : {}));
    await this.dispatch(config);
  }

  /** A draft was carried to `version` without an AI run; returns the run that holds it now. */
  moved(fromId: string, version: string): string {
    const { state, id } = moveRun(this.state, fromId, version, this.now());
    this.commit(state);
    return id;
  }

  /** Done with it: the run is not re-decided by later polls, and its workspace is archived. */
  async skip(itemKey: string, rule: string): Promise<void> {
    const latest = this.state.runs
      .filter((run) => run.itemKey === itemKey && run.rule === rule)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!latest) throw new Error(`No run for ${itemKey} / ${rule}`);
    if (latest.state === "running") throw new Error("It's running; stop the agent first");
    this.commit(setRun(this.state, latest.id, { state: "done", reason: DISMISSED }, this.now()));
    // Every run of this item and rule had its own worktree; none is needed any more.
    const workspaces = new Set(this.state.runs.filter((run) => run.itemKey === itemKey && run.rule === rule && run.workspaceId && run.state !== "running").map((run) => run.workspaceId!));
    for (const workspaceId of workspaces) await this.deps.archive?.(workspaceId).catch((error) => console.error("archive failed", workspaceId, error));
  }

  /** The run an inbox agent belongs to: its latest one. */
  runForAgent(agentId: string): Run | null {
    return [...this.state.runs].reverse().find((run) => run.agentId === agentId) ?? null;
  }

  run(id: string): Run | null {
    return this.state.runs.find((run) => run.id === id) ?? null;
  }

  item(key: string) {
    return this.state.items[key] ?? null;
  }

  /** Undo Dismiss: the run is back to needs-decision with `reason`, without announcing it again. */
  restore(runId: string, reason: string): void {
    const run = this.run(runId);
    if (!run || run.state !== "done" || run.reason !== DISMISSED) throw new Error("Only a dismissed run can be restored");
    this.commit(setRun(this.state, runId, { state: "needs-decision", reason }, this.now()));
  }

  /** A review draft was saved: the human has something to decide on, even if the agent is still finishing. */
  markDrafted(runId: string, reason: string): void {
    this.commit(setRun(this.state, runId, { state: "needs-decision", reason }, this.now()));
    const run = this.run(runId);
    if (run) void this.deps.announce?.(run, reason.replace(/^review drafted: /, "")).catch(() => undefined);
    void this.afterChange();
  }

  markHandedOff(runId: string, to: string, url: string): void {
    this.commit(setRun(this.state, runId, { state: "done", reason: `handed off to @${to}: ${url}` }, this.now()));
  }

  /** A PR pasted by URL: tracked under the "manual" source and queued with the manual rule now. */
  async addManual(pr: Pr): Promise<Run> {
    const config = this.deps.loadConfig();
    if (!config) throw new Error("Nothing configured yet: add a rule in Settings → Inbox first");
    const rule = config.rules.find((candidate) => candidate.name === config.manualRule) ?? config.rules[0];
    if (!rule) throw new Error("No rule to run: add one in Settings → Inbox");
    const now = this.now();
    const prior = this.state.items[pr.key];
    this.commit({ ...this.state, items: { ...this.state.items, [pr.key]: { pr, sources: [...new Set([...(prior?.sources ?? []), "manual"])], lastSeenAt: now } } });
    this.commit(requeue(this.state, config, pr.key, rule.name, now));
    const id = this.state.runs.find((run) => run.itemKey === pr.key && run.rule === rule.name && run.version === pr.headSha)!.id;
    // Under "manual", so a poll of the rule's own source never closes it for being absent there.
    this.commit(setRun(this.state, id, { source: "manual" }, now));
    const checkout = Object.keys(config.checkouts).some((repo) => repo.toLowerCase() === pr.repo.toLowerCase());
    if (!checkout) this.commit(setRun(this.state, id, { state: "no-checkout", reason: noCheckoutReason(pr.repo) }, now));
    await this.dispatch(config);
    return this.run(id)!;
  }

  markPosted(runId: string, url: string): void {
    this.commit(setRun(this.state, runId, { state: "done", reason: `review posted: ${url}` }, this.now()));
  }

  /** A slot freed up: start whatever is queued. */
  private async afterChange(): Promise<void> {
    const config = safe(() => this.deps.loadConfig());
    if (config) await this.dispatch(config);
  }

  private commit(next: State): void {
    this.state = next;
    this.deps.save(next);
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const safe = <T>(read: () => T): T | null => {
  try {
    return read();
  } catch {
    return null;
  }
};
