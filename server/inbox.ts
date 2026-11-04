import { DISMISSED, modeFor, plan, renderPrompt, providerFor, requeue, setRun, startable, type Config, type InboxView, type Pr, type Run, type State } from "../shared/inbox";

export interface StartRequest {
  run: Run;
  pr: Pr;
  cwd: string;
  provider: string;
  mode: string;
  prompt: string;
}

export interface InboxDeps {
  loadConfig: () => Config | null;
  search: (query: string) => Promise<Pr[]>;
  start: (request: StartRequest) => Promise<{ agentId: string; workspaceId?: string | null }>;
  load: () => State;
  save: (state: State) => void;
  /** Archives an inbox agent's workspace (and its worktree) once the human is done with it. */
  archive?: (workspaceId: string) => Promise<void>;
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
    return { items: this.state.items, runs: this.state.runs, lastPollAt: this.lastPollAt, errors: this.errors };
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
      this.errors = ["No inbox.json yet: create it to add sources and rules (see the README)."];
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
    this.lastPollAt = this.now();
    this.errors = errors;
    await this.dispatch(config);
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
        const started = await this.deps.start({ run, pr, cwd, provider: providerFor(rule, config), mode: modeFor(rule, config), prompt: renderPrompt(rule, pr) });
        this.commit(setRun(this.state, run.id, { agentId: started.agentId, workspaceId: started.workspaceId ?? undefined }, this.now()));
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
    void this.afterChange();
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
    this.commit(requeue(this.state, config, itemKey, rule, this.now()));
    await this.dispatch(config);
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

  /** A review draft was saved: the human has something to decide on, even if the agent is still finishing. */
  markDrafted(runId: string, reason: string): void {
    this.commit(setRun(this.state, runId, { state: "needs-decision", reason }, this.now()));
    void this.afterChange();
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
