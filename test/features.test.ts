import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GithubMembership, parsePrRef } from "../server/github";
import { Inbox, type StartRequest } from "../server/inbox";
import { handoffDraft, postDraft, previewDraft } from "../server/post";
import { ReviewStore } from "../server/reviews";
import { callTool, permissionAnswer } from "../server/tools";
import { emptyState, isUnconfigured, type State } from "../shared/inbox";
import { composeReview, prContext, ReviewInputSchema, toDraft, updateComment, type PrDetails } from "../shared/review";
import { decideTrust, parseTrust, untrustedAllows } from "../shared/trust";
import { config, NOW, pr } from "./fixtures";

const PATH = "src/basket/BasketPage.tsx";
const files = [{ path: PATH, status: "modified", additions: 2, deletions: 0, patch: "@@ -10,3 +10,5 @@\n a\n+b\n+c\n d\n+e" }];
const details = (headSha = "aaaaaaa111"): PrDetails => ({
  body: "Why",
  author: "ola",
  baseRef: "main",
  headRef: "x",
  headSha,
  additions: 2,
  deletions: 0,
  changedFiles: 1,
  createdAt: NOW,
  files,
  threads: [{ id: 501, path: PATH, line: 11, side: "RIGHT", author: "kuba", body: "State is lost on refresh.", url: "https://x/501", inReplyTo: null }],
  title: "Basket",
  requestedReviewers: ["me", "kasia"],
});

describe("trust", () => {
  const members = { inOrg: async (org: string, login: string) => org === "acme" && login !== "outsider", inTeam: async (_org: string, team: string, login: string) => team === "core" && login === "ola" };
  it("parses people rules and refuses repos", () => {
    const { rules, errors } = parseTrust(["@ola", "@acme/*", "@acme/core", "!@bot-*", "acme/shop", "private"]);
    expect(rules.map((rule) => [rule.kind, rule.deny])).toEqual([["login", false], ["org", false], ["team", false], ["login", true]]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("Repos can't be trusted");
  });
  it("denials win, then the first grant; nobody by default", async () => {
    expect(await decideTrust("ola", [], members)).toEqual({ trusted: false, because: "no trust rules (trust nobody)" });
    expect(await decideTrust("ola", ["@acme/*"], members)).toEqual({ trusted: true, because: "trusted by @acme/*" });
    expect(await decideTrust("outsider", ["@acme/*"], members)).toEqual({ trusted: false, because: "no trust rule matches" });
    expect(await decideTrust("bot-ci", ["@acme/*", "!@bot-*"], members)).toEqual({ trusted: false, because: "denied by !@bot-*" });
    expect(await decideTrust("ola", ["@acme/core"], members)).toMatchObject({ trusted: true });
  });
  it("a failed membership lookup is 'not a member'", async () => {
    const failing = { inOrg: async () => Promise.reject(new Error("404")), inTeam: async () => false };
    expect(await decideTrust("ola", ["@acme/*"], failing)).toMatchObject({ trusted: false });
    const gh = vi.fn(async () => Promise.reject(new Error("HTTP 404")));
    expect(await new GithubMembership(gh).inOrg("acme", "ola")).toBe(false);
  });
  it("untrusted runs may read and use inbox tools only", () => {
    expect(["Read", "Grep", "mcp__inbox__inbox_pr"].map((tool) => untrustedAllows(tool, "inbox"))).toEqual([true, true, true]);
    expect(["Bash", "Edit", "Write", "WebFetch", "mcp__asks__ask_create"].map((tool) => untrustedAllows(tool, "inbox"))).toEqual([false, false, false, false, false]);
  });
});

describe("permission answers", () => {
  const tool = (name: string) => ({ kind: "tool" as const, name, metadata: undefined });
  it("lets inbox tools through, gates untrusted runs, leaves trusted ones to their mode", () => {
    expect(permissionAnswer(tool("mcp__inbox__inbox_review_draft"), false)).toBe("allow");
    expect(permissionAnswer(tool("Read"), false)).toBe("allow");
    expect(permissionAnswer(tool("Bash"), false)).toBe("deny");
    expect(permissionAnswer(tool("Edit"), false)).toBe("deny");
    expect(permissionAnswer(tool("Bash"), true)).toBeNull();
    expect(permissionAnswer(tool("Bash"), undefined)).toBeNull();
  });
});

describe("already raised", () => {
  const draft = toDraft(ReviewInputSchema.parse({ verdict: "request-changes", confidence: 80, summary: "s", comments: [{ path: PATH, line: 11, severity: "blocker", body: "Lost on refresh.", raised: 501 }, { path: PATH, line: 12, body: "New point." }] }), { id: "r", itemKey: "acme/shop#7", version: "aaaaaaa111" }, NOW);
  it("holds a raised finding back by default, replies on request, or posts it as new", () => {
    expect(composeReview(draft, files)).toMatchObject({ held: 1, replies: [] });
    expect(composeReview(draft, files).payload.comments.map((comment) => comment.line)).toEqual([12]);
    const reply = updateComment(draft, "c1", { reply: true });
    expect(composeReview(reply, files)).toMatchObject({ held: 0, replies: [{ commentId: 501, body: "🚨 **blocker** — Lost on refresh." }] });
    const asNew = updateComment(draft, "c1", { unraise: true });
    expect(composeReview(asNew, files).payload.comments.map((comment) => comment.line)).toEqual([11, 12]);
  });
  it("the reviewer sees others' comments with ids in inbox_pr", () => {
    const text = prContext({ url: "https://github.com/acme/shop/pull/7", title: "Basket" }, details());
    expect(text).toContain("- id 501 · @kuba · src/basket/BasketPage.tsx:11: State is lost on refresh.");
    expect(text).toContain("```diff\n@@ -10,3 +10,5 @@");
    expect(prContext({ url: "u", title: "t" }, details(), 200)).toContain("[... diff truncated");
  });
});

describe("body override", () => {
  it("replaces the composed body until cleared", () => {
    const draft = toDraft(ReviewInputSchema.parse({ verdict: "approve", confidence: 90, summary: "Generated." }), { id: "r", itemKey: "k", version: "v" }, NOW);
    expect(composeReview(draft, files).payload.body).toContain("Generated.");
    const edited = composeReview({ ...draft, bodyOverride: "My words." }, files);
    expect(edited.payload.body).toBe("My words.");
    expect(edited.generatedBody).toContain("Generated.");
  });
});

/** An inbox with one review run drafted by agent-1 at aaaaaaa111. */
async function drafted(extra: Partial<Parameters<typeof toDraft>[0]> = {}) {
  let state: State = emptyState();
  const started: StartRequest[] = [];
  const inbox = new Inbox({
    loadConfig: () => config({ trust: ["@ola"] }),
    search: async (query) => (query.includes("review-requested") ? [pr()] : []),
    start: async (request) => (started.push(request), { agentId: "agent-1", workspaceId: "ws" }),
    load: () => state,
    save: (next) => (state = next),
    now: () => NOW,
    trust: async (target, cfg) => decideTrust(target.author, cfg.trust, { inOrg: async () => false, inTeam: async () => false }),
  });
  const reviews = new ReviewStore(mkdtempSync(join(tmpdir(), "inbox-features-")));
  await inbox.poll();
  await callTool(inbox, reviews, "agent-1", "inbox_review_draft", { verdict: "approve", confidence: 90, summary: "Fine.", comments: [{ path: PATH, line: 11, body: "Same as kuba.", raised: 501 }], ...extra }, NOW);
  return { inbox, reviews, state: () => state, started, runId: state.runs[0]!.id };
}

describe("trust at dispatch", () => {
  it("records whether the run was trusted, and why not", async () => {
    const { started, state } = await drafted();
    expect(started[0]!.trusted).toBe(true);
    let s2: State = emptyState();
    const inbox = new Inbox({ loadConfig: () => config(), search: async (q) => (q.includes("review-requested") ? [pr({ author: "outsider" })] : []), start: async () => ({ agentId: "a" }), load: () => s2, save: (n) => (s2 = n), now: () => NOW, trust: async (target, cfg) => decideTrust(target.author, cfg.trust, { inOrg: async () => false, inTeam: async () => false }) });
    await inbox.poll();
    expect(s2.runs[0]).toMatchObject({ trusted: false, reason: "read-only run: no trust rules (trust nobody)" });
    expect(state().runs[0]!.trusted).toBe(true);
  });
});

describe("posting with replies, preview, handoff", () => {
  it("preview shows what posts; post sends held-back nothing and replies after the review", async () => {
    const { inbox, reviews, runId } = await drafted();
    const preview = await previewDraft(inbox, reviews, runId, async () => details());
    expect(preview).toMatchObject({ event: "APPROVE", held: 1, comments: [], replies: [], edited: false });
    reviews.save(updateComment(reviews.get(runId)!, "c1", { reply: true }));
    const ghJson = vi.fn(async () => "{}");
    const post = vi.fn(async () => "https://x/review");
    expect(await postDraft(inbox, reviews, runId, post, async () => details(), NOW, ghJson)).toMatchObject({ replies: 1, failedReplies: 0 });
    expect(ghJson).toHaveBeenCalledWith(["api", "--method", "POST", "repos/acme/shop/pulls/7/comments/501/replies", "--input", "-"], { body: "Same as kuba." });
  });

  it("handoff requests them, withdraws me, and notes it (or sends the draft as a COMMENT)", async () => {
    const { inbox, reviews, runId, state } = await drafted();
    const calls: [string[], unknown][] = [];
    const ghJson = vi.fn(async (args: string[], body: unknown) => (calls.push([args, body]), JSON.stringify({ html_url: "https://x/comment" })));
    const post = vi.fn(async () => "https://x/review-comment");
    await expect(handoffDraft(inbox, reviews, runId, { to: "me", note: "", sendDraft: false }, { details: async () => details(), ghJson, me: async () => "me", post })).rejects.toThrow("That's you");
    expect(await handoffDraft(inbox, reviews, runId, { to: "@kasia", note: "You know the basket.", sendDraft: false }, { details: async () => details(), ghJson, me: async () => "me", post }, NOW)).toEqual({ url: "https://x/comment" });
    expect(calls.map(([args, body]) => [args[2], args[3], body])).toEqual([
      ["POST", "repos/acme/shop/pulls/7/requested_reviewers", { reviewers: ["kasia"] }],
      ["DELETE", "repos/acme/shop/pulls/7/requested_reviewers", { reviewers: ["me"] }],
      ["POST", "repos/acme/shop/issues/7/comments", { body: "@kasia, I'm handing this review to you. You know the basket." }],
    ]);
    expect(state().runs[0]).toMatchObject({ state: "done", reason: "handed off to @kasia: https://x/comment" });
    await expect(postDraft(inbox, reviews, runId, post, async () => details())).rejects.toThrow("Already posted");

    const second = await drafted();
    await handoffDraft(second.inbox, second.reviews, second.runId, { to: "kasia", note: "", sendDraft: true }, { details: async () => details(), ghJson, me: async () => "me", post }, NOW);
    expect(post).toHaveBeenCalledWith("acme/shop", 7, expect.objectContaining({ event: "COMMENT", body: expect.stringContaining("My draft so far:") }));
  });
});

describe("pasted PRs", () => {
  it("parses links and short refs", () => {
    expect(parsePrRef("https://github.com/acme/shop/pull/7/files")).toEqual({ repo: "acme/shop", number: 7 });
    expect(parsePrRef("acme/shop#7")).toEqual({ repo: "acme/shop", number: 7 });
    expect(parsePrRef("nope")).toBeNull();
  });
  it("queues the manual rule under a 'manual' source that polls never close", async () => {
    let state: State = emptyState();
    const started: StartRequest[] = [];
    const inbox = new Inbox({ loadConfig: () => config({ manualRule: "draft-review" }), search: async () => [], start: async (r) => (started.push(r), { agentId: "a" }), load: () => state, save: (n) => (state = n), now: () => NOW });
    const run = await inbox.addManual(pr({ number: 42 }));
    expect(run).toMatchObject({ source: "manual", rule: "draft-review", state: "running" });
    await inbox.poll();
    expect(state.runs[0]!.state).toBe("running");
    const noCheckout = await inbox.addManual(pr({ repo: "other/repo", number: 1 }));
    expect(noCheckout.state).toBe("no-checkout");
  });
});

describe("settings", () => {
  it("defaults count as unconfigured, so inbox.json still applies", () => {
    expect(isUnconfigured(config({ sources: {}, rules: [] }))).toBe(true);
    expect(isUnconfigured(config())).toBe(false);
  });
});
