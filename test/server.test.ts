import { describe, expect, it, vi } from "vitest";
import { Inbox, type InboxDeps, type StartRequest } from "../server/inbox";
import { type Pr, type State } from "../shared/inbox";
import { config, emptyState, later, NOW, pr } from "./fixtures";

function harness(results: Record<string, Pr[]> = {}, overrides: Partial<InboxDeps> = {}) {
  let saved: State = emptyState();
  let clock = 0;
  const started: StartRequest[] = [];
  const deps: InboxDeps = {
    loadConfig: () => config({ maxConcurrent: 1 }),
    search: async (query) => results[Object.entries(config().sources).find(([, source]) => source.github === query)![0]] ?? [],
    start: async (request) => {
      started.push(request);
      return { agentId: `agent-${started.length}`, workspaceId: "ws" };
    },
    load: () => saved,
    save: (state) => {
      saved = state;
    },
    now: () => later(clock++),
    ...overrides,
  };
  return { inbox: new Inbox(deps), started, saved: () => saved };
}

describe("Inbox", () => {
  it("starts a matching PR in its checkout with the rendered prompt and provider", async () => {
    const { inbox, started, saved } = harness({ review: [pr()] });
    await inbox.poll();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ cwd: "/src/shop", provider: "claude", mode: "auto" });
    expect(started[0]!.prompt).toContain("Review https://github.com/acme/shop/pull/7");
    expect(saved().runs[0]).toMatchObject({ state: "running", agentId: "agent-1", workspaceId: "ws" });
    expect(inbox.isInboxAgent("agent-1")).toBe(true);
  });

  it("respects maxConcurrent and starts the next one when a turn ends", async () => {
    const { inbox, started, saved } = harness({ review: [pr({ number: 1 }), pr({ number: 2 })] });
    await inbox.poll();
    expect(started.map((request) => request.pr.number)).toEqual([1]);
    inbox.turnEnded("agent-1", { kind: "completed" });
    await vi.waitFor(() => expect(started.map((request) => request.pr.number)).toEqual([1, 2]));
    expect(saved().runs.map((run) => run.state)).toEqual(["needs-decision", "running"]);
  });

  it("records failed turns and closed agents", async () => {
    const { inbox, saved } = harness({ review: [pr({ number: 1 })] });
    await inbox.poll();
    inbox.turnEnded("agent-1", { kind: "failed", error: { message: "rate limited" } });
    expect(saved().runs[0]).toMatchObject({ state: "failed", reason: "rate limited" });
    inbox.turnEnded("agent-1", { kind: "completed" });
    expect(saved().runs[0]!.state).toBe("failed");
  });

  it("marks a run failed when the agent can't start", async () => {
    const { inbox, saved } = harness({ review: [pr()] }, { start: async () => Promise.reject(new Error("no worktree")) });
    await inbox.poll();
    expect(saved().runs[0]).toMatchObject({ state: "failed", reason: "could not start the agent: no worktree" });
  });

  it("keeps a run queued when GitHub rate-limits the agent start, and starts it next poll", async () => {
    let limited = true;
    const started: string[] = [];
    const { inbox, saved } = harness({ review: [pr()] }, {
      start: async ({ run }) => {
        if (limited) throw new Error("GitHub CLI command failed: API rate limit already exceeded for user ID 1");
        started.push(run.id);
        return { agentId: "agent-1" };
      },
    });
    await inbox.poll();
    expect(saved().runs[0]).toMatchObject({ state: "queued", reason: "GitHub rate limit; retrying on the next poll" });
    limited = false;
    await inbox.poll();
    expect(started).toHaveLength(1);
    expect(saved().runs[0]!.state).toBe("running");
  });

  it("waits with queued runs until a Paseo session exists", async () => {
    let ready = false;
    const { inbox, started } = harness({ review: [pr()] }, { ready: () => ready });
    await inbox.poll();
    expect(started).toHaveLength(0);
    ready = true;
    await inbox.poll();
    expect(started).toHaveLength(1);
  });

  it("reports a failing source without dropping the others", async () => {
    const { inbox, started } = harness({}, {
      search: async (query) => {
        if (query.includes("needs-qa")) throw new Error("gh: not logged in");
        return query.includes("review-requested") ? [pr()] : [];
      },
    });
    await inbox.poll();
    expect(inbox.view().errors).toEqual(["qa: gh: not logged in"]);
    expect(started).toHaveLength(1);
  });

  it("explains a missing or invalid config", async () => {
    const missing = harness({}, { loadConfig: () => null });
    await missing.inbox.poll();
    expect(missing.inbox.view().errors[0]).toMatch(/^No inbox.json yet/);
    const invalid = harness({}, { loadConfig: () => { throw new Error("rules.0.prompt: Required"); } });
    await invalid.inbox.poll();
    expect(invalid.inbox.view().errors).toEqual(["inbox.json is invalid: rules.0.prompt: Required"]);
  });

  it("hands runs that were running at restart to the human", () => {
    const state: State = {
      items: { "acme/shop#7": { pr: pr(), sources: ["review"], lastSeenAt: NOW } },
      runs: [{ id: "r", itemKey: "acme/shop#7", source: "review", rule: "draft-review", version: "aaaaaaa111", state: "running", agentId: "a", updatedAt: NOW }],
    };
    let saved = state;
    new Inbox({ loadConfig: () => config(), search: async () => [], start: async () => ({ agentId: "x" }), load: () => state, save: (next) => (saved = next) });
    expect(saved.runs[0]).toMatchObject({ state: "needs-decision", reason: "plugin restarted while it ran" });
  });

  it("Run now reruns a finished item; Dismiss stops later polls from re-deciding it", async () => {
    const { inbox, started, saved } = harness({ review: [pr()], mine: [pr({ checks: "pending" })] }, { loadConfig: () => config() });
    await inbox.poll();
    inbox.turnEnded("agent-1", { kind: "completed" });
    await inbox.runNow("acme/shop#7", "draft-review");
    expect(started).toHaveLength(2);

    await inbox.skip("acme/shop#7", "fix-ci");
    await inbox.poll();
    expect(saved().runs.find((run) => run.rule === "fix-ci")).toMatchObject({ state: "done", reason: "dismissed" });
    await expect(inbox.skip("acme/shop#7", "draft-review")).rejects.toThrow("It's running");
  });

  it("Dismiss archives the workspaces of that item's runs", async () => {
    const archived: string[] = [];
    const { inbox } = harness({ review: [pr()] }, { archive: async (id) => void archived.push(id) });
    await inbox.poll();
    inbox.turnEnded("agent-1", { kind: "completed" });
    await inbox.skip("acme/shop#7", "draft-review");
    expect(archived).toEqual(["ws"]);
  });
});
