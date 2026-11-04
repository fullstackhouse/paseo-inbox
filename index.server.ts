import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { installBridge } from "./server/bridge";
import { GithubSource, postPullReview, PrDetailsCache } from "./server/github";
import { guardEnv, installShims, RUN_ENV } from "./server/guard";
import { Inbox, type StartRequest } from "./server/inbox";
import { listen } from "./server/listener";
import { postDraft } from "./server/post";
import { ReviewStore } from "./server/reviews";
import { dataDir, loadConfig, StateStore } from "./server/store";
import { callTool, isInboxPermission, PREAPPROVED } from "./server/tools";
import { listInbox, pollNow, runNow, skipRun } from "./shared/inbox";
import { getPrDetails, getReview, INSTRUCTIONS, MCP_SERVER, postReview, TOOLS, updateComment, updateReviewComment } from "./shared/review";

export const RUN_LABEL = "inbox.run";
export const PR_LABEL = "inbox.pr";

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
  const shimDir = installShims(dir);
  const store = new StateStore(dir);
  const reviews = new ReviewStore(dir);
  const mcp = installBridge(dir);
  const github = new GithubSource();
  const prDetails = new PrDetailsCache();
  // The daemon session behind `paseo` lives as long as this subprocess; any hook or handler hands it over.
  let paseo: PaseoApi | null = null;
  const capture = (api: PaseoApi) => {
    paseo ??= api;
  };

  const start = async ({ run, pr, cwd, provider, mode, prompt }: StartRequest) => {
    if (!paseo) throw new Error("No Paseo session yet");
    const created = await paseo.agents.create({
      cwd,
      worktree: { mode: "checkout-pr", prNumber: pr.number },
      background: true,
      title: `Inbox · ${run.rule} · ${pr.repo}#${pr.number}`,
      config: { provider, modeId: mode },
      labels: { [RUN_LABEL]: run.id, [PR_LABEL]: pr.url },
      env: { [RUN_ENV]: run.id },
      prompt,
    });
    await created.refresh().catch(() => null);
    return { agentId: created.id, workspaceId: created.workspaceId };
  };

  const inbox = new Inbox({ loadConfig: () => loadConfig(), search: (query) => github.search(query), start,
    ready: () => paseo !== null,
    archive: async (workspaceId) => {
      await paseo?.workspaces.archive(workspaceId);
    }, load: () => store.load(), save: (state) => store.save(state) });

  // Inbox agents, and only those, get the review-draft tool.
  server.before("agent.create", ({ request }, { paseo: api }) => {
    capture(api);
    if (!request.env?.[RUN_ENV]) return;
    const { config } = request;
    const preapproved = [...(config.toolPolicy?.preapproved ?? []), ...PREAPPROVED];
    return { ...request, config: { ...config, mcpServers: { ...config.mcpServers, [MCP_SERVER]: mcp }, toolPolicy: { preapproved } } };
  });
  // Asking modes prompt even for preapproved MCP tools; these only save a draft locally.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo: api }) => {
    capture(api);
    if (!inbox.isInboxAgent(agent.id) || !isInboxPermission(request)) return;
    await api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  // The write guard: inbox agents get `gh`/`git` shims first on PATH, on create and on every resume.
  server.before("agent.session_open", ({ request }, { paseo: api }) => {
    capture(api);
    const marked = request.env[RUN_ENV] || inbox.isInboxAgent(request.agentId);
    if (!marked) return;
    return { ...request, env: guardEnv({ ...request.env, [RUN_ENV]: request.env[RUN_ENV] || "resumed" }, shimDir) };
  });
  server.on("agent.turn_ended", ({ agent, outcome }, { paseo: api }) => {
    capture(api);
    inbox.turnEnded(agent.id, outcome);
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
  server.handle(updateReviewComment, ({ runId, commentId, status, body }, { paseo: api }) => {
    capture(api);
    const draft = reviews.get(runId);
    if (!draft) throw new Error("No review draft for this run");
    const next = updateComment(draft, commentId, body !== undefined ? { body } : { status: status ?? "kept" });
    reviews.save(next);
    return next;
  });
  // The only path from a review draft to GitHub: the Inbox screen's Post button.
  server.handle(postReview, ({ runId }, { paseo: api }) => {
    capture(api);
    return postDraft(inbox, reviews, runId, (repo, number, payload) => postPullReview(repo, number, payload));
  });

  const listening = listen(dir, {
    "/instructions": async () => ({ instructions: INSTRUCTIONS }),
    "/tools": async () => ({ tools: TOOLS }),
    "/call": async ({ agentId, name, arguments: args }) => callTool(inbox, reviews, agentId ?? null, name, args),
  });

  // Poll on the configured interval; the config is re-read every tick, so edits apply without a reload.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async () => {
    await inbox.poll().catch((error) => console.error("inbox poll failed", error));
    if (!stopped) timer = setTimeout(tick, safeInterval() * 1000);
  };
  timer = setTimeout(tick, 5_000);

  return async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    (await listening).close();
  };
}

function safeInterval(): number {
  try {
    return loadConfig()?.pollSeconds ?? 300;
  } catch {
    return 300;
  }
}
