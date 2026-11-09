import { describe, expect, it } from "vitest";
import { ConfigSchema, DISMISSED, draftsReviews, globToRegExp, groupRuns, matchesQuery, mismatch, needsDecisionCount, opensReview, plan, renderPrompt, requeue, reviewRunFor, runId, setRun, startable, type Run } from "../shared/inbox";
import { config, emptyState, later, NOW, pr } from "./fixtures";

const states = (state: ReturnType<typeof plan>) => state.runs.map((run) => [run.rule, run.version, run.state]);

describe("globToRegExp", () => {
  it.each([
    ["**/*.tsx", "src/a/B.tsx", true],
    ["**/*.tsx", "B.tsx", true],
    ["**/*.tsx", "src/a/B.ts", false],
    ["packages/ui/src/**", "packages/ui/src/x/y.css", true],
    ["packages/ui/src/**", "packages/api/src/x.ts", false],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/?.ts", "src/a.ts", true],
  ])("%s ~ %s → %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
});

describe("ConfigSchema", () => {
  it("requires provider/model, globally and per rule", () => {
    expect(ConfigSchema.safeParse({ provider: "claude" }).error?.issues[0]?.message).toMatch(/^use "provider\/model"/);
    expect(ConfigSchema.safeParse({ rules: [{ name: "r", source: "s", prompt: "p", provider: "codex" }] }).success).toBe(false);
    expect(ConfigSchema.parse({ provider: "codex/gpt-5.5" }).provider).toBe("codex/gpt-5.5");
  });
});

describe("mismatch", () => {
  const qa = config().rules[1]!;
  it("matches when a changed file hits a path glob", () => expect(mismatch(qa, pr())).toBeNull());
  it("explains a path miss", () => expect(mismatch(qa, pr({ files: ["README.md"] }))).toBe("no changed file matches its paths"));
  it("checks labels case-insensitively", () => {
    const rule = { ...qa, paths: undefined, labels: ["Needs-QA"] };
    expect(mismatch(rule, pr({ labels: ["needs-qa"] }))).toBeNull();
    expect(mismatch(rule, pr())).toBe("missing label Needs-QA");
  });
  it("checks CI state and draft", () => {
    const fix = config().rules[2]!;
    expect(mismatch(fix, pr({ checks: "pending" }))).toBe("checks are pending, not failing");
    expect(mismatch({ ...fix, when: undefined, draft: false }, pr({ isDraft: true }))).toBe("is a draft");
  });
});

describe("plan", () => {
  it("queues a matching PR once per head SHA", () => {
    const first = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    expect(states(first)).toEqual([["draft-review", "aaaaaaa111", "queued"]]);
    const again = plan({ config: config(), results: { review: [pr()] }, state: first, now: later(5) });
    expect(again.runs).toEqual(first.runs);
  });

  it("marks the older version stale and queues the new push (on-push)", () => {
    let state = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "needs-decision", agentId: "a1" }, NOW);
    state = plan({ config: config(), results: { review: [pr({ headSha: "bbbbbbb222" })] }, state, now: later(5) });
    expect(states(state)).toEqual([
      ["draft-review", "aaaaaaa111", "stale"],
      ["draft-review", "bbbbbbb222", "queued"],
    ]);
  });

  it("leaves a running agent alone when a new push arrives", () => {
    let state = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "running" }, NOW);
    state = plan({ config: config(), results: { review: [pr({ headSha: "bbbbbbb222" })] }, state, now: later(5) });
    expect(states(state)[0]).toEqual(["draft-review", "aaaaaaa111", "running"]);
  });

  it("runs a once-rule a single time across pushes", () => {
    let state = plan({ config: config(), results: { mine: [pr({ checks: "failing" })] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "done" }, NOW);
    state = plan({ config: config(), results: { mine: [pr({ checks: "failing", headSha: "bbbbbbb222" })] }, state, now: later(5) });
    expect(states(state)).toEqual([["fix-ci", "aaaaaaa111", "done"]]);
  });

  it("records a skip with the reason, then re-decides it at the same SHA when the PR changes", () => {
    let state = plan({ config: config(), results: { mine: [pr({ checks: "pending" })] }, state: emptyState(), now: NOW });
    expect(state.runs[0]).toMatchObject({ state: "skipped", reason: "fix-ci: checks are pending, not failing" });
    state = plan({ config: config(), results: { mine: [pr({ checks: "failing" })] }, state, now: later(5) });
    expect(states(state)).toEqual([["fix-ci", "aaaaaaa111", "queued"]]);
  });

  it("holds a PR without a local checkout, and queues it once one is configured", () => {
    const other = pr({ repo: "acme/api" });
    let state = plan({ config: config(), results: { review: [other] }, state: emptyState(), now: NOW });
    expect(state.runs[0]).toMatchObject({ state: "no-checkout", reason: "no clone of acme/api on this machine" });
    const withCheckout = config({ checkouts: { "acme/shop": "/src/shop", "ACME/api": "/src/api" } });
    state = plan({ config: withCheckout, results: { review: [other] }, state, now: later(5) });
    expect(state.runs[0]!.state).toBe("queued");
  });

  it("queues a held run once its repo gets a checkout, even when its source didn't answer", () => {
    const other = pr({ repo: "acme/api" });
    let state = plan({ config: config(), results: { review: [other] }, state: emptyState(), now: NOW });
    state = { ...state, runs: state.runs.map((run) => ({ ...run, source: "manual" })) };
    state = plan({ config: config({ checkouts: { "acme/shop": "/src/shop", "acme/api": "/src/api" } }), results: { review: [] }, state, now: later(5) });
    expect(state.runs[0]).toMatchObject({ state: "queued", reason: undefined });
  });

  it("records manual rules as skipped until Run now", () => {
    const manual = config({ rules: [{ name: "draft-review", source: "review", prompt: "x", rerun: "manual" }] });
    const state = plan({ config: manual, results: { review: [pr()] }, state: emptyState(), now: NOW });
    expect(state.runs[0]).toMatchObject({ state: "skipped", reason: "manual rule: use Run now" });
  });

  it("keeps items from a source that failed to poll, and forgets items unseen for 7 days", () => {
    const first = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    const failedPoll = plan({ config: config(), results: {}, state: first, now: later(60) });
    expect(Object.keys(failedPoll.items)).toEqual(["acme/shop#7"]);
    const weekLater = plan({ config: config(), results: { review: [] }, state: first, now: later(8 * 24 * 60) });
    expect(weekLater).toEqual({ items: {}, runs: [] });
  });

  it("ignores sources without rules but still tracks the item", () => {
    const state = plan({ config: config({ rules: [] }), results: { review: [pr()] }, state: emptyState(), now: NOW });
    expect(state.runs).toEqual([]);
    expect(state.items["acme/shop#7"]!.sources).toEqual(["review"]);
  });
});

describe("plan: settling", () => {
  it("closes waiting runs of a PR that left its source (reviewed on GitHub, merged, closed)", () => {
    let state = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "needs-decision" }, NOW);
    state = plan({ config: config(), results: { review: [] }, state, now: later(5) });
    expect(state.runs[0]).toMatchObject({ state: "done", reason: "no longer in review: reviewed on GitHub, merged or closed" });
  });
  it("doesn't close runs when the source failed to poll, nor a running agent", () => {
    let state = plan({ config: config(), results: { review: [pr({ number: 1 }), pr({ number: 2 })] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "running" }, NOW);
    expect(plan({ config: config(), results: {}, state, now: later(5) }).runs.map((run) => run.state)).toEqual(["running", "queued"]);
    expect(plan({ config: config(), results: { review: [] }, state, now: later(5) }).runs.map((run) => run.state)).toEqual(["running", "done"]);
  });
  it("a dismissed PR isn't drafted again on later pushes", () => {
    let state = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "done", reason: DISMISSED }, NOW);
    state = plan({ config: config(), results: { review: [pr({ headSha: "bbbbbbb222" })] }, state, now: later(5) });
    expect(state.runs.map((run) => [run.version, run.state])).toEqual([["aaaaaaa111", "done"]]);
  });
});

describe("startable", () => {
  it("fills free slots with the oldest queued runs", () => {
    let state = plan({ config: config(), results: { review: [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3 })] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[1]!.id, { state: "running" }, later(1));
    expect(startable(state, 2).map((run) => run.itemKey)).toEqual(["acme/shop#1"]);
    expect(startable(state, 1)).toEqual([]);
  });
});

describe("requeue", () => {
  it("queues the current version again and refuses a running one", () => {
    let state = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "needs-decision" }, NOW);
    state = requeue(state, config(), "acme/shop#7", "draft-review", later(1));
    expect(states(state)).toEqual([["draft-review", "aaaaaaa111", "queued"]]);
    state = setRun(state, runId("acme/shop#7", "draft-review", "aaaaaaa111"), { state: "running" }, later(2));
    expect(() => requeue(state, config(), "acme/shop#7", "draft-review", later(3))).toThrow("Already running");
    expect(() => requeue(state, config(), "acme/shop#7", "nope", later(3))).toThrow("Unknown rule nope");
  });
});

describe("renderPrompt", () => {
  it("fills placeholders and prepends the no-writes preamble", () => {
    const prompt = renderPrompt(config().rules[1]!, pr());
    expect(prompt).toMatch(/^You were started by paseo-inbox for https:\/\/github.com\/acme\/shop\/pull\/7 at aaaaaaa111\./);
    expect(prompt).toContain("Do not write to GitHub");
    expect(prompt.endsWith("QA #7")).toBe(true);
  });
  it("leaves unknown placeholders as they are", () => {
    expect(renderPrompt({ ...config().rules[0]!, prompt: "{{nope}}" }, pr()).endsWith("{{nope}}")).toBe(true);
  });
});

describe("groupRuns", () => {
  it("shows the latest run per item and rule, decisions first", () => {
    let state = plan({ config: config(), results: { review: [pr()] }, state: emptyState(), now: NOW });
    state = setRun(state, state.runs[0]!.id, { state: "needs-decision" }, NOW);
    state = plan({ config: config(), results: { review: [pr({ headSha: "bbbbbbb222" })], qa: [pr({ number: 9 })] }, state, now: later(5) });
    state = setRun(state, runId("acme/shop#9", "qa", "aaaaaaa111"), { state: "needs-decision" }, later(6));
    const groups = groupRuns(state.runs);
    expect(groups.map((group) => [group.state, group.runs.map((run) => run.itemKey)])).toEqual([
      ["needs-decision", ["acme/shop#9"]],
      ["queued", ["acme/shop#7"]],
    ]);
    expect(needsDecisionCount(state.runs, new Set())).toBe(1);
  });
});

describe("needsDecisionCount", () => {
  const run = (id: string, state: Run["state"], workspaceId?: string): Run => ({ id, itemKey: `o/r#${id}`, source: "review", rule: "draft-review", version: "a", state, workspaceId, updatedAt: NOW });
  const runs = [run("1", "needs-decision", "w1"), run("2", "needs-decision", "w2"), run("3", "needs-decision"), run("4", "queued", "w1")];

  it("counts runs waiting on a decision", () => {
    expect(needsDecisionCount(runs, new Set())).toBe(3);
  });

  it("leaves out runs in snoozed workspaces", () => {
    expect(needsDecisionCount(runs, new Set(["w2"]))).toBe(2);
    expect(needsDecisionCount(runs, new Set(["w1", "w2"]))).toBe(1);
  });
});

describe("opensReview", () => {
  const view = { reviewRules: config().rules.filter(draftsReviews).map((rule) => rule.name) };
  const at = (state: Run["state"], rule = "draft-review", reason?: string): Run => ({ id: "r", itemKey: "o/r#1", source: "review", rule, version: "a", state, reason, updatedAt: NOW });

  it("knows which rules draft reviews", () => {
    expect(view.reviewRules).toEqual(["draft-review"]);
  });

  it("opens a review rule's run while it is queued or drafting", () => {
    expect(opensReview(at("running"), view)).toBe(true);
    expect(opensReview(at("queued"), view)).toBe(true);
    expect(opensReview(at("running", "qa"), view)).toBe(false);
    expect(opensReview(at("running"), null)).toBe(false);
  });

  it("opens a drafted review, and not a finished run that never drafted one", () => {
    expect(opensReview(at("needs-decision", "draft-review", "review drafted: approve · 90%"), view)).toBe(true);
    expect(opensReview(at("needs-decision", "draft-review", "turn ended without a draft"), view)).toBe(false);
  });

  it("opens a dismissed run whose draft is still saved", () => {
    expect(opensReview(at("done", "draft-review", DISMISSED), view)).toBe(false);
    expect(opensReview(at("done", "draft-review", DISMISSED), { ...view, drafts: ["r"] })).toBe(true);
  });
});

describe("matchesQuery", () => {
  const run: Run = { id: "r", itemKey: "acme/shop#7", source: "review", rule: "draft-review", version: "a", state: "done", reason: DISMISSED, updatedAt: NOW };
  const item = { ...pr(), title: "Fix the checkout total", author: "dawid", labels: ["needs-qa"] };

  it("matches every term against key, title, author, labels, rule and reason, ignoring case", () => {
    expect(matchesQuery(run, item, "checkout FIX")).toBe(true);
    expect(matchesQuery(run, item, "shop#7 dawid")).toBe(true);
    expect(matchesQuery(run, item, "needs-qa dismissed")).toBe(true);
    expect(matchesQuery(run, item, "checkout refund")).toBe(false);
    expect(matchesQuery(run, undefined, "acme")).toBe(true);
  });

  it("matches a pasted PR link to that PR only, even with a comment anchor", () => {
    expect(matchesQuery(run, item, "https://github.com/Acme/shop/pull/7#issuecomment-1")).toBe(true);
    expect(matchesQuery(run, item, "https://github.com/acme/shop/pull/70")).toBe(false);
    expect(matchesQuery(run, item, "acme/shop#7")).toBe(true);
  });
});

describe("reviewRunFor", () => {
  const view = { reviewRules: ["draft-review"], drafts: [] };
  const run = (id: string, patch: Partial<Run>): Run => ({ id, itemKey: "acme/shop#7", source: "review", rule: "draft-review", version: "a", state: "done", updatedAt: NOW, ...patch });

  it("picks the PR's newest run that opens a review, by link or owner/repo#N", () => {
    const runs = [
      run("old", { reason: "review posted: x" }),
      run("new", { state: "needs-decision", reason: "review approve 80%", updatedAt: later(5) }),
      run("qa", { rule: "qa", state: "running", updatedAt: later(9) }),
      run("other", { itemKey: "acme/shop#8", state: "needs-decision", reason: "review x", updatedAt: later(9) }),
    ];
    expect(reviewRunFor(runs, view, "https://github.com/Acme/shop/pull/7")?.id).toBe("new");
    expect(reviewRunFor(runs, view, "acme/shop#7")?.id).toBe("new");
  });

  it("is null for a PR without a review run or a ref that is not a PR", () => {
    const runs = [run("qa", { rule: "qa", state: "running" })];
    expect(reviewRunFor(runs, view, "acme/shop#7")).toBeNull();
    expect(reviewRunFor(runs, view, "acme/shop#9")).toBeNull();
    expect(reviewRunFor(runs, view, "not a pr")).toBeNull();
  });
});
