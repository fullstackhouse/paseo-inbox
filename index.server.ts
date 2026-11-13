import { fetchPrUpstream } from "./server/upstream";
import { getPrUpstream, previewPrUpstream } from "./shared/upstream";
import type { PaseoApi, PaseoWorkspaceHandle } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBridge } from "./server/bridge";
import { openInBrowser } from "./server/open";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { compareCommits, ghWithInput, GithubMembership, GithubSource, latestReviewBy, postPullReview, PrDetailsCache, reviewRequests, whoami } from "./server/github";
import { filesAt, reanchorRun, sinceRun } from "./server/rereview";
import { reanchorReview, reviewSince } from "./shared/rereview";
import { Inbox, type StartRequest } from "./server/inbox";
import { listen } from "./server/listener";
import { handoffDraft, postDraft, previewDraft } from "./server/post";
import { ReviewStore } from "./server/reviews";
import { addToConfigFile, findClone } from "./server/checkouts";
import { configPath, dataDir, expandCheckouts, loadConfig, StateStore } from "./server/store";
import { callTool, permissionAnswer, PREAPPROVED } from "./server/tools";
import { addCheckout, addPr, findCheckout, isUnconfigured, listInbox, parsePrRef, pollNow, restoreRun, runNow, skipRun, type Config } from "./shared/inbox";
import { inboxSettings, readLegacyConfig } from "./shared/settings";
import { decideTrust } from "./shared/trust";
import {
  addHumanComment,
  addReviewComment,
  deleteHumanComment,
  deleteReviewComment,
  discussReview,
  effectiveVerdict,
  getPrDetails,
  previewPr,
  getReview,
  handoffReview,
  INSTRUCTIONS,
  MCP_SERVER,
  openExternal,
  patchPrint,
  postReview,
  previewReview,
  prPeople,
  setReviewBody,
  setFileViewed,
  setReviewVerdict,
  severityFromRpc,
  TOOLS,
  updateComment,
  updateReviewComment,
  draftHeadline,
  type ReviewDraft,
} from "./shared/review";

export const RUN_LABEL = "inbox.run";
export const PR_LABEL = "inbox.pr";
/** Env var marking a session as inbox-started; its value is the run id. */
export const RUN_ENV = "PASEO_INBOX_RUN";
/** Env marker on a session the inbox started read-only (its PR's author isn't trusted). */
const UNTRUSTED_ENV = "PASEO_INBOX_UNTRUSTED";

type Notification = { title: string; body: string; open?: { screen: string; params?: Record<string, string> }; key?: string };
type Notifier = { notifications?: { send(input: Notification): Promise<unknown> } };

/** Only hosts with plugin notifications have `paseo.notifications` (FSH Paseo); elsewhere this does nothing. */
async function notify(paseo: unknown, input: Notification): Promise<boolean> {
  const notifications = (paseo as Notifier).notifications;
  if (typeof notifications?.send !== "function") return false;
  await notifications.send({ ...input, title: input.title.slice(0, 120), body: input.body.slice(0, 500) });
  return true;
}

const shortPr = (pr: string) => pr.replace(/^[^/]+\//, "");

/** "Review draft ready", opening the review screen. Elsewhere the chat card is the only signal. */
export function notifyDraftReady(paseo: unknown, draft: { runId: string; pr: string; title: string; headline: string }): Promise<boolean> {
  return notify(paseo, {
    title: `Review draft ready · ${shortPr(draft.pr)}`,
    body: `${draft.title} — ${draft.headline}`,
    open: { screen: "review", params: { runId: draft.runId } },
    key: `draft:${draft.runId}`,
  });
}

/**
 * A run's turn ended without a draft, opening the Inbox. Inbox agents run in background
 * workspaces, whose own "finished" notification the daemon mutes, so this is the only signal.
 */
export function notifyRunEnded(paseo: unknown, run: { runId: string; pr: string; title: string; failed: boolean; reason?: string }): Promise<boolean> {
  return notify(paseo, {
    title: `${run.failed ? "Inbox run failed" : "Inbox run finished"} · ${shortPr(run.pr)}`,
    body: `${run.title} — ${run.reason ?? "no review draft; open the Inbox to decide"}`,
    open: { screen: "inbox" },
    key: `ended:${run.runId}`,
  });
}

/**
 * The checkout names the PR's repo. Left to the daemon, the repo comes from `gh repo view`, which
 * prefers an `upstream` remote over `origin`, so a clone whose `upstream` is another project looks
 * the PR up there. The SDK's type doesn't declare `projectPath` yet; FSH Paseo reads it.
 */
export function prWorktree(pr: { repo: string; number: number }): { mode: "checkout-pr"; prNumber: number; projectPath: string } {
  return { mode: "checkout-pr", prNumber: pr.number, projectPath: pr.repo };
}

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
  const store = new StateStore(dir);
  const reviews = new ReviewStore(dir);
  const mcp = installBridge(dir);
  const github = new GithubSource();
  const prDetails = new PrDetailsCache();
  const membership = new GithubMembership();
  const details = (repo: string, number: number) => prDetails.get(repo, number);
  const ghJson = (args: string[], body: unknown) => ghWithInput(args, JSON.stringify(body));
  // The signed-in login, looked up once (a failure isn't remembered).
  let login: Promise<string> | null = null;
  const me = () => (login ??= whoami().catch((error) => ((login = null), Promise.reject(error))));
  const compare = (repo: string, base: string, head: string) => compareCommits(repo, base, head);
  const draftFilesAt = filesAt((repo, number, sha) => prDetails.cachedFiles(repo, number, sha), compare);
  // An empty gh config for untrusted runs: gh there has no account to speak for.
  const emptyGh = join(dir, "untrusted-gh");
  mkdirSync(emptyGh, { recursive: true });

  // Settings live in Paseo's own store; until they hold any sources or rules, a legacy inbox.json applies.
  const settings = server.registerSettings(inboxSettings);
  let fromSettings: Config | null = null;
  let settingsError: string | null = null;
  const take = (state: Awaited<ReturnType<typeof settings.read>>) => {
    fromSettings = state.status === "ready" ? state.values : null;
    settingsError = state.status === "invalid" ? state.error : null;
  };
  void settings.read().then(take).catch(() => undefined);
  // A settings change applies now: poll again rather than waiting for the next tick.
  const unsubscribe = settings.subscribe((state) => {
    take(state);
    // Deferred: `inbox` is created further down this function, so it exists by the time this fires.
    setTimeout(() => void inbox.poll().catch(() => undefined), 0);
  });
  const currentConfig = (): Config | null => {
    if (settingsError) throw new Error(`Settings are invalid: ${settingsError}`);
    if (fromSettings && !isUnconfigured(fromSettings)) return expandCheckouts(fromSettings);
    return loadConfig();
  };
  // The daemon session behind `paseo` lives as long as this subprocess; any hook or handler hands it over.
  let paseo: PaseoApi | null = null;
  const capture = (api: PaseoApi) => {
    paseo ??= api;
  };

  const start = async ({ run, pr, cwd, provider, mode, prompt, trusted }: StartRequest) => {
    if (!paseo) throw new Error("No Paseo session yet");
    // An untrusted run asks before every tool, and the permission hook below answers: reads yes,
    // everything else no. Claude's "default" mode is the one that asks.
    if (!trusted && !provider.startsWith("claude")) throw new Error("Untrusted runs need a Claude provider (they rely on its asking mode); trust the author or switch the model");
    const created = await paseo.agents.create({
      cwd,
      worktree: prWorktree(pr),
      background: true,
      title: `Inbox · ${run.rule} · ${pr.repo}#${pr.number}${trusted ? "" : " · read-only"}`,
      config: { provider, modeId: trusted ? mode : "default" },
      labels: { [RUN_LABEL]: run.id, [PR_LABEL]: pr.url },
      env: { [RUN_ENV]: run.id, ...(trusted ? {} : { [UNTRUSTED_ENV]: "1" }) },
      prompt: trusted ? prompt : `${prompt}\n\nThis run is read-only: ${pr.author ? `@${pr.author}` : "the author"} isn't on your trust list, so you can read files and use the inbox tools but can't run commands.`,
    });
    await created.refresh().catch(() => null);
    return { agentId: created.id, workspaceId: created.workspaceId };
  };

  const inbox = new Inbox({
    loadConfig: currentConfig,
    search: (query) => github.search(query),
    start,
    ready: () => paseo !== null,
    requests: (pr) => reviewRequests(pr.repo, pr.number),
    me,
    draftOf: (runId) => {
      const draft = reviews.get(runId);
      return draft ? { posted: Boolean(draft.postedUrl), verdict: effectiveVerdict(draft) } : null;
    },
    hasDraft: (runId) => reviews.has(runId),
    trust: (pr, config) => decideTrust(pr.author, config.trust, membership),
    announce: async (run, headline) => {
      if (!paseo || !run.agentId) return;
      const pr = inbox.item(run.itemKey)?.pr;
      // The chat's composer pill opens the review; hosts with plugin notifications (FSH Paseo) also notify, and tapping opens it too.
      await notifyDraftReady(paseo, { runId: run.id, pr: run.itemKey, title: pr?.title ?? run.itemKey, headline }).catch((error) => console.error("notify failed", error));
    },
    ended: async (run) => {
      if (!paseo) return;
      const title = inbox.item(run.itemKey)?.pr.title ?? run.itemKey;
      await notifyRunEnded(paseo, { runId: run.id, pr: run.itemKey, title, failed: run.state === "failed", reason: run.reason }).catch((error) => console.error("notify failed", error));
    },
    archive: async (workspaceId) => {
      await paseo?.workspaces.archive(workspaceId);
    },
    reveal: async (workspaceId) => {
      if (!paseo) return;
      // Hosts with workspaceBackgroundSet (FSH Paseo) have setBackground; elsewhere the run stays hidden.
      const workspace = paseo.workspaces.ref(workspaceId) as PaseoWorkspaceHandle & { setBackground?: (background: boolean) => Promise<unknown> };
      await workspace.setBackground?.(false);
    }, load: () => store.load(), save: (state) => store.save(state) });

  // Inbox agents, and only those, get the review-draft tool.
  server.before("agent.create", ({ request }, { paseo: api }) => {
    capture(api);
    if (!request.env?.[RUN_ENV]) return;
    const { config } = request;
    const preapproved = [...(config.toolPolicy?.preapproved ?? []), ...PREAPPROVED];
    return { ...request, config: { ...config, mcpServers: { ...config.mcpServers, [MCP_SERVER]: mcp }, toolPolicy: { preapproved } } };
  });
  // Asking modes prompt even for preapproved MCP tools; these only read the PR or save a draft locally.
  // For a read-only (untrusted) run this hook is the gate: reads and inbox tools pass, the rest is denied.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo: api }) => {
    capture(api);
    if (!inbox.isInboxAgent(agent.id)) return;
    const answer = permissionAnswer(request, inbox.runForAgent(agent.id)?.trusted);
    if (!answer) return;
    await api.agents.ref(agent.id).respondToPermission({
      requestId: request.id,
      response: answer === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "This review run is read-only: the PR's author isn't on the trust list. Read the files and use inbox_pr instead." },
    });
  });

  // Credential hygiene for read-only runs (Cerber §14.3), not a sandbox: no gh account, no git
  // credential helpers or prompts, no ssh identities. Applied on create and on every resume.
  server.before("agent.session_open", ({ request }, { paseo: api }) => {
    capture(api);
    const untrusted = request.env[UNTRUSTED_ENV] === "1" || inbox.runForAgent(request.agentId)?.trusted === false;
    if (!untrusted) return;
    return {
      ...request,
      env: {
        ...request.env,
        [UNTRUSTED_ENV]: "1",
        GH_CONFIG_DIR: emptyGh,
        GH_TOKEN: "",
        GITHUB_TOKEN: "",
        GH_ENTERPRISE_TOKEN: "",
        GITHUB_ENTERPRISE_TOKEN: "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        SSH_AUTH_SOCK: "",
        GIT_SSH_COMMAND: "ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null",
      },
    };
  });
  server.on("agent.turn_ended", ({ agent, outcome }, { paseo: api }) => {
    capture(api);
    inbox.turnEnded(agent.id, outcome);
  });
  server.on("agent.turn_started", ({ agent }, { paseo: api }) => {
    capture(api);
    inbox.turnStarted(agent.id);
  });
  server.on("agent.closed", ({ agent }) => inbox.agentGone(agent.id));
  server.on("agent.archived", ({ agent }) => inbox.agentGone(agent.id));

  server.handle(listInbox, (_input, { paseo: api }) => {
    capture(api);
    return inbox.view();
  });
  server.handle(pollNow, async (_input, { paseo: api }) => {
    capture(api);
    await inbox.poll();
    return inbox.view();
  });
  server.handle(runNow, async ({ itemKey, rule }, { paseo: api }) => {
    capture(api);
    await inbox.runNow(itemKey, rule);
    return { ok: true as const };
  });
  server.handle(skipRun, async ({ itemKey, rule }, { paseo: api }) => {
    capture(api);
    await inbox.skip(itemKey, rule);
    return { ok: true as const };
  });

  server.handle(getReview, ({ runId }, { paseo: api }) => {
    capture(api);
    return reviews.get(runId);
  });
  server.handle(getPrDetails, ({ itemKey }, { paseo: api }) => {
    capture(api);
    const item = inbox.item(itemKey);
    if (!item) throw new Error(`Unknown PR ${itemKey}`);
    return prDetails.get(item.pr.repo, item.pr.number);
  });
  server.handle(previewPr, async ({ ref }, { paseo: api }) => {
    capture(api);
    const parsed = parsePrRef(ref);
    if (!parsed) throw new Error("Not a GitHub PR link (https://github.com/owner/repo/pull/123) or owner/repo#123");
    const details = await prDetails.get(parsed.repo, parsed.number);
    return { ...parsed, url: `https://github.com/${parsed.repo}/pull/${parsed.number}`, details };
  });
  server.handle(getPrUpstream, ({ itemKey }, { paseo: api }) => {
    capture(api);
    const item = inbox.item(itemKey);
    if (!item) throw new Error(`Unknown PR ${itemKey}`);
    return fetchPrUpstream(item.pr.repo, item.pr.number);
  });
  server.handle(previewPrUpstream, ({ ref }, { paseo: api }) => {
    capture(api);
    const parsed = parsePrRef(ref);
    if (!parsed) throw new Error("Not a GitHub PR link (https://github.com/owner/repo/pull/123) or owner/repo#123");
    return fetchPrUpstream(parsed.repo, parsed.number);
  });
  const editDraft = (runId: string, change: (draft: ReviewDraft) => ReviewDraft) => {
    const draft = reviews.get(runId);
    if (!draft) throw new Error("No review draft for this run");
    const next = change(draft);
    reviews.save(next);
    return next;
  };
  server.handle(updateReviewComment, ({ runId, commentId, status, body, severity, reply, unraise }, { paseo: api }) => {
    capture(api);
    return editDraft(runId, (draft) =>
      updateComment(
        draft,
        commentId,
        body !== undefined ? { body } : severity !== undefined ? { severity: severityFromRpc(severity) } : reply !== undefined ? { reply } : unraise ? { unraise: true } : { status: status ?? "kept" },
      ),
    );
  });
  server.handle(addReviewComment, ({ runId, severity, ...comment }, { paseo: api }) => {
    capture(api);
    return editDraft(runId, (draft) => addHumanComment(draft, { ...comment, severity: severityFromRpc(severity) }));
  });
  server.handle(deleteReviewComment, ({ runId, commentId }, { paseo: api }) => {
    capture(api);
    return editDraft(runId, (draft) => deleteHumanComment(draft, commentId));
  });
  server.handle(setReviewVerdict, ({ runId, verdict }, { paseo: api }) => {
    capture(api);
    return editDraft(runId, (draft) => {
      if (draft.postedUrl) throw new Error("Already posted");
      return { ...draft, verdictOverride: verdict === null || verdict === draft.verdict ? undefined : verdict };
    });
  });
  server.handle(setFileViewed, ({ runId, path, patch, viewed }, { paseo: api }) => {
    capture(api);
    return editDraft(runId, (draft) => {
      const next = { ...draft.viewed };
      if (viewed) next[path] = patchPrint(patch);
      else delete next[path];
      return { ...draft, viewed: next };
    });
  });
  server.handle(openExternal, async ({ url }, { paseo: api }) => {
    capture(api);
    await openInBrowser(url);
    return { ok: true as const };
  });
  server.handle(discussReview, async ({ runId, message }, { paseo: api }) => {
    capture(api);
    const agentId = inbox.run(runId)?.agentId;
    if (!agentId) throw new Error("This run has no reviewer agent");
    await api.agents.ref(agentId).send(message);
    return { ok: true as const };
  });
  server.handle(restoreRun, ({ runId }, { paseo: api }) => {
    capture(api);
    const draft = reviews.get(runId);
    if (!draft || draft.postedUrl) throw new Error(draft ? "This review was already posted" : "This run has no review draft");
    inbox.restore(runId, `review drafted: ${draftHeadline(draft)}`);
    return { ok: true as const };
  });
  // The only paths from a review draft to GitHub: buttons on the review screen.
  server.handle(postReview, ({ runId }, { paseo: api }) => {
    capture(api);
    return postDraft(inbox, reviews, runId, (repo, number, payload) => postPullReview(repo, number, payload), details, undefined, ghJson, draftFilesAt);
  });
  server.handle(handoffReview, ({ runId, to, note, sendDraft }, { paseo: api }) => {
    capture(api);
    return handoffDraft(inbox, reviews, runId, { to, note, sendDraft }, { details, ghJson, me, post: (repo, number, payload) => postPullReview(repo, number, payload) });
  });
  server.handle(reanchorReview, ({ runId }, { paseo: api }) => {
    capture(api);
    return reanchorRun(inbox, reviews, runId, { details, filesAt: draftFilesAt });
  });
  server.handle(reviewSince, ({ runId }, { paseo: api }) => {
    capture(api);
    return sinceRun(inbox, reviews, runId, { details, me, latestReview: (repo, number, login) => latestReviewBy(repo, number, login), compare });
  });
  server.handle(previewReview, ({ runId }, { paseo: api }) => {
    capture(api);
    return previewDraft(inbox, reviews, runId, details, draftFilesAt);
  });
  server.handle(setReviewBody, ({ runId, body }, { paseo: api }) => {
    capture(api);
    return editDraft(runId, (draft) => {
      if (draft.postedUrl) throw new Error("Already posted");
      const { bodyOverride: _old, ...rest } = draft;
      return body === null || !body.trim() ? rest : { ...rest, bodyOverride: body };
    });
  });
  server.handle(prPeople, async ({ itemKey }, { paseo: api }) => {
    capture(api);
    const item = inbox.item(itemKey);
    if (!item) throw new Error(`Unknown PR ${itemKey}`);
    const [self, live, collaborators] = await Promise.all([
      me().catch(() => ""),
      details(item.pr.repo, item.pr.number).catch(() => null),
      github.collaborators(item.pr.repo).catch(() => [] as string[]),
    ]);
    const people = [...new Set([...(live?.requestedReviewers ?? []), ...(live?.threads.map((thread) => thread.author) ?? []), ...collaborators])].filter(
      (login) => login && login.toLowerCase() !== self.toLowerCase() && login.toLowerCase() !== item.pr.author.toLowerCase() && !/\[bot\]$/.test(login),
    );
    return { me: self, people };
  });
  server.handle(addPr, async ({ ref }, { paseo: api }) => {
    capture(api);
    const pr = await github.one(ref);
    const run = await inbox.addManual(pr);
    return { itemKey: pr.key, runId: run.id };
  });
  server.handle(findCheckout, ({ repo }, { paseo: api }) => {
    capture(api);
    let configured: string[] = [];
    try {
      configured = Object.values(currentConfig()?.checkouts ?? {});
    } catch {
      // An invalid config still lets the usual folders be searched.
    }
    return { path: findClone(repo, configured) };
  });
  server.handle(addCheckout, async ({ repo, path }, { paseo: api }) => {
    capture(api);
    if (fromSettings && !isUnconfigured(fromSettings)) throw new Error("The inbox reads Settings → Inbox; save the repo there");
    addToConfigFile(configPath(), repo, path);
    await inbox.poll();
    return { ok: true as const };
  });
  server.handle(readLegacyConfig, (_input, { paseo: api }) => {
    capture(api);
    try {
      return { path: configPath(), config: loadConfig(), error: null };
    } catch (error) {
      return { path: configPath(), config: null, error: error instanceof Error ? error.message : String(error) };
    }
  });

  const listening = listen(dir, {
    "/instructions": async () => ({ instructions: INSTRUCTIONS }),
    "/tools": async () => ({ tools: TOOLS }),
    "/call": async ({ agentId, name, arguments: args }) => callTool(inbox, reviews, agentId ?? null, name, args, undefined, details),
  });

  // Poll on the configured interval; the config is re-read every tick, so edits apply without a reload.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async () => {
    await inbox.poll().catch((error) => console.error("inbox poll failed", error));
    if (!stopped) timer = setTimeout(tick, safeInterval(currentConfig) * 1000);
  };
  timer = setTimeout(tick, 5_000);

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
    (await listening).close();
  };
}

function safeInterval(config: () => Config | null): number {
  try {
    return config()?.pollSeconds ?? 300;
  } catch {
    return 300;
  }
}
