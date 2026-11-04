# paseo-inbox

Paseo plugin: GitHub PR searches → rules → one agent per match, with a PATH guard that blocks GitHub writes from those agents. Design: SPEC-048 in `fullstackhouse/fsh-monorepo`.

## Layout

- `shared/inbox.ts`: config/state Zod schemas, RPCs (`inbox.list`, `inbox.run_now`, `inbox.skip`, `inbox.poll_now`; names must match `^[a-z][a-z0-9._-]*$`), and the pure core: `mismatch` (rule filters), `plan` (poll results + state → next state: stale older versions, queue/skip/no-checkout new ones, re-decide never-started runs at the same SHA, forget items unseen 7 days), `startable`, `requeue`, `renderPrompt` (+ no-writes preamble), `groupRuns`. Test logic here.
- `server/inbox.ts`: `Inbox` loop over injected deps (config, search, start, store, archive, ready): poll → plan → dispatch within `maxConcurrent`; `turnEnded`/`agentGone` move runs on; runs still `running` at startup become `needs-decision`.
- `server/github.ts`: `GithubSource` (`gh search prs` + `gh pr view` details cached by URL + `updatedAt`), `summarizeChecks`, `queryArgs`.
- `server/guard.ts`: `GUARD_JS` (standalone Node script, the exact file the tests execute), `installShims` (`gh`/`git` → guard), `guardEnv` (shim dir first on PATH for marked sessions).
- `shared/review.ts` + `server/{tools,reviews,post,bridge,listener}.ts`: review drafts. `inbox_review_draft` MCP tool, injected in `before("agent.create")` only for sessions with `PASEO_INBOX_RUN`, via the stdio bridge copied from paseo-prs. It saves a `ReviewDraft` per run and moves the run to needs-decision. `postDraft` (RPC `inbox.review_post`, called only by the card's Post button) posts with `gh api … /reviews --input -` from the plugin process, refusing stale or already-posted drafts. `client/ReviewDraftView.tsx` renders it on the card.
- `server/store.ts`: `~/.paseo/inbox.json` loader (`~` expanded), `StateStore` (atomic JSON).
- `index.server.ts`: timer, `agents.create` (`worktree: checkout-pr`, `background`, labels `inbox.run`/`inbox.pr`, env `PASEO_INBOX_RUN`), `before("agent.session_open")` applies the guard, `turn_ended`/`closed`/`archived` hooks, RPCs.
- Reading: `shared/highlight.ts` (small tokenizer, per diff line, block comments carried across lines), `shared/markdown.ts` (tables, images as links, `line` per block, `addedText` for added files). An added `.md` file opens as a document with comments under their paragraphs. Viewed marks live on the draft as `viewed[path] = patchPrint(patch)`, so a changed patch unticks.
- Review screen: `client/ReviewScreen.tsx` (header, sticky tabs, post bar, prev/next via `reviewQueue`), `FileDiff` (`shared/diff.ts` `parsePatch` + `anchors`), `CommentCard` (keep/edit/drop through RPC `inbox.review_comment` → `updateComment`), `Markdown` (`shared/markdown.ts`, native Text). PR body and file patches come from RPC `inbox.pr_get` → `PrDetailsCache` (`gh api pulls/N` + `/files --paginate --slurp`, cached per head SHA). Screens get no `openScreen` prop, so `client/nav.ts` holds the client's.
- `client/`: `InboxScreen` (grouped runs, actions), `useInbox` (RPC polling); `index.client.tsx` registers the screen and a sidebar row with the needs-decision count.

- Settings: `shared/settings.ts` (`defineSettings`, schema = `ConfigSchema`), registered on the server (read + subscribe only; servers can't write). `client/SettingsScreen.tsx` is under Settings → Plugins → paseo-inbox. Settings win once they hold sources or rules, otherwise `inbox.json`. The screen imports it.
- Trust: `shared/trust.ts` (`parseTrust`, `decideTrust`, `untrustedAllows`), membership via `GithubMembership`. Untrusted = `modeId: "default"` + `permissionAnswer` (server/tools.ts) denying all but reads and inbox tools + credential-free env in `session_open`.
- `inbox_pr` (`prContext`): description, diff, others' threads with ids. Comments carry `raised` (thread id) and `reply`. `composeReview` holds back raised comments, and `postDraft` posts replies after the review.
- Handoff (`handoffDraft`), preview and body override (`previewDraft`, `bodyOverride`), pasted PRs (`Inbox.addManual`, source "manual"), the "Open review" timeline card (`announce` → `timeline.append`, `client/ReviewCard.tsx`).

## Load-bearing facts (Paseo 0.12)

- The plugin has no `paseo` handle until a hook or RPC hands one over; polling runs without it, dispatch waits (`ready`).
- `process.execPath` in the desktop app is the Electron helper: the shims run it with `ELECTRON_RUN_AS_NODE=1`, and the guard strips that before spawning the real tool.
- `ToolPolicy` has no deny list, and a permission hook only fires in asking modes; hence the PATH guard, and agents run in `mode` (default `auto`) so they never stall on a prompt.
- An ask's Send prompts the same guarded agent, so it can't perform the write. Writes go through a plugin RPC behind a UI button.
- A GitHub rate limit on agent start keeps the run queued. The daemon's checkout-pr GraphQL call is the first thing to hit the limit.
- `checkout-pr` makes a new worktree per run (`<branch>-N`); Dismiss archives them via `paseo.workspaces.archive`.

## Commands

- `npm run typecheck`, `npm test`.
- After edits: `paseo plugin reload paseo-inbox`; `paseo plugin ls` must say `running`; logs: `paseo plugin logs paseo-inbox`. Never restart the daemon.
- UI check without the daemon password: `scripts/ui-sandbox.sh start|stop`, which copies `plugin-data/inbox` to `/tmp/inbox-ui`, write its `config.json` (listen `127.0.0.1:6790`, CORS `http://127.0.0.1:6767`, `pluginsEnabled`, and no `inbox.json`), run `paseo daemon run --home /tmp/inbox-ui`, install the plugin with `--home`, then open `http://127.0.0.1:6767` in Playwright and use Direct connection to `127.0.0.1:6790`.
- Live check: a temporary `inbox.json` with one `once` rule on your own PR and harmless commands (`gh pr comment 999999`, `git push --dry-run`); delete the agent, its worktree, and the config afterwards.
