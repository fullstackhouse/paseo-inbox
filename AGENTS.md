# paseo-inbox

Paseo plugin: GitHub PR searches → rules → one agent per match, with a PATH guard that blocks GitHub writes from those agents. Design: SPEC-048 in `fullstackhouse/fsh-monorepo`.

## Layout

- `shared/inbox.ts`: config/state Zod schemas, RPCs (`inbox.list`, `inbox.run_now`, `inbox.skip`, `inbox.poll_now`; names must match `^[a-z][a-z0-9._-]*$`), and the pure core: `mismatch` (rule filters), `plan` (poll results + state → next state: stale older versions, queue/skip/no-checkout new ones, re-decide never-started runs at the same SHA, forget items unseen 7 days), `startable`, `requeue`, `renderPrompt` (+ no-writes preamble), `groupRuns`. Test logic here.
- `server/inbox.ts`: `Inbox` loop over injected deps (config, search, start, store, archive, ready): poll → plan → dispatch within `maxConcurrent`; `turnEnded`/`agentGone` move runs on; runs still `running` at startup become `needs-decision`.
- `server/github.ts`: `GithubSource` (`gh search prs` + `gh pr view` details cached by URL + `updatedAt`), `summarizeChecks`, `queryArgs`.
- `server/guard.ts`: `GUARD_JS` (standalone Node script, the exact file the tests execute), `installShims` (`gh`/`git` → guard), `guardEnv` (shim dir first on PATH for marked sessions).
- `server/store.ts`: `~/.paseo/inbox.json` loader (`~` expanded), `StateStore` (atomic JSON).
- `index.server.ts`: timer, `agents.create` (`worktree: checkout-pr`, `background`, labels `inbox.run`/`inbox.pr`, env `PASEO_INBOX_RUN`), `before("agent.session_open")` applies the guard, `turn_ended`/`closed`/`archived` hooks, RPCs.
- `client/`: `InboxScreen` (grouped runs, actions), `useInbox` (RPC polling); `index.client.tsx` registers the screen and a sidebar row with the needs-decision count.

## Load-bearing facts (Paseo 0.12)

- The plugin has no `paseo` handle until a hook or RPC hands one over; polling runs without it, dispatch waits (`ready`).
- `process.execPath` in the desktop app is the Electron helper: the shims run it with `ELECTRON_RUN_AS_NODE=1`, and the guard strips that before spawning the real tool.
- `ToolPolicy` has no deny list, and a permission hook only fires in asking modes; hence the PATH guard, and agents run in `mode` (default `auto`) so they never stall on a prompt.
- `checkout-pr` makes a new worktree per run (`<branch>-N`); Dismiss archives them via `paseo.workspaces.archive`.

## Commands

- `npm run typecheck`, `npm test`.
- After edits: `paseo plugin reload paseo-inbox`; `paseo plugin ls` must say `running`; logs: `paseo plugin logs paseo-inbox`. Never restart the daemon.
- Live check: a temporary `inbox.json` with one `once` rule on your own PR and harmless commands (`gh pr comment 999999`, `git push --dry-run`); delete the agent, its worktree, and the config afterwards.
