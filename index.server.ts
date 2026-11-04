import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { GithubSource } from "./server/github";
import { guardEnv, installShims, RUN_ENV } from "./server/guard";
import { Inbox, type StartRequest } from "./server/inbox";
import { dataDir, loadConfig, StateStore } from "./server/store";
import { listInbox, pollNow, runNow, skipRun } from "./shared/inbox";

export const RUN_LABEL = "inbox.run";
export const PR_LABEL = "inbox.pr";

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
  const shimDir = installShims(dir);
  const store = new StateStore(dir);
  const github = new GithubSource();
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

  // Poll on the configured interval; the config is re-read every tick, so edits apply without a reload.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const tick = async () => {
    await inbox.poll().catch((error) => console.error("inbox poll failed", error));
    if (!stopped) timer = setTimeout(tick, safeInterval() * 1000);
  };
  timer = setTimeout(tick, 5_000);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function safeInterval(): number {
  try {
    return loadConfig()?.pollSeconds ?? 300;
  } catch {
    return 300;
  }
}
