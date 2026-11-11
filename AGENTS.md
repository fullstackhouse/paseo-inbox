# paseo-inbox

Paseo plugin: GitHub PR searches → rules → one agent per match. Untrusted authors' PRs get read-only runs without credentials. Design: SPEC-048 in `fullstackhouse/fsh-monorepo`.

## Layout

- `shared/inbox.ts`: config/state Zod schemas, RPCs (`inbox.list`, `inbox.run_now`, `inbox.skip`, `inbox.poll_now`; names must match `^[a-z][a-z0-9._-]*$`), and the pure core: `mismatch` (rule filters), `plan` (poll results + state → next state: stale older versions, queue/skip/no-checkout new ones, re-decide never-started runs at the same SHA, forget items unseen 7 days), `startable`, `requeue`, `renderPrompt` (+ no-writes preamble), `groupRuns`. Test logic here.
- `server/inbox.ts`: `Inbox` loop over injected deps (config, search, start, store, archive, ready): poll → plan → dispatch within `maxConcurrent`; `turnEnded`/`agentGone` move runs on; runs still `running` at startup become `needs-decision`.
- `server/github.ts`: `GithubSource` (`gh search prs` + `gh pr view` details cached by URL + `updatedAt`), `summarizeChecks`, `queryArgs`.
- `shared/review.ts` + `server/{tools,reviews,post,bridge,listener}.ts`: review drafts. `inbox_review_draft` MCP tool, injected in `before("agent.create")` only for sessions with `PASEO_INBOX_RUN`, via the stdio bridge copied from paseo-prs. It saves a `ReviewDraft` per run and moves the run to needs-decision. `postDraft` (RPC `inbox.review_post`, called only by the card's Post button) posts with `gh api … /reviews --input -` from the plugin process, refusing already-posted drafts. A draft the PR moved past posts with its own `commit_id`, placed against the diff at that commit (`filesAt`). `client/ReviewDraftView.tsx` renders it on the card.
- `server/checkouts.ts`: `findClone` (RPC `inbox.checkout_find`; a folder named like the repo whose `.git/config` remote points at it, beside configured checkouts or under `~/src`-style folders) and `addToConfigFile` (RPC `inbox.checkout_add`, legacy inbox.json only; with settings in use the client saves them). `plan` queues any no-checkout run whose repo now has a checkout.
- `server/store.ts`: `~/.paseo/inbox.json` loader (`~` expanded), `StateStore` (atomic JSON).
- `index.server.ts`: timer, `agents.create` (`worktree: checkout-pr`, `background`, labels `inbox.run`/`inbox.pr`, env `PASEO_INBOX_RUN`), `before("agent.session_open")` strips credentials from untrusted runs, `turn_ended`/`closed`/`archived` hooks, RPCs.
- Reading: `shared/highlight.ts` (small tokenizer, per diff line, block comments carried across lines), `shared/markdown.ts` (`addedText` for added files). An added `.md` file opens as a document with comments under their paragraphs. Viewed marks live on the draft as `viewed[path] = patchPrint(patch)`, so a changed patch unticks.
- Review screen: `client/ReviewScreen.tsx` (header, sticky tabs, post bar, prev/next via `reviewQueue`), `FileDiff` (`shared/diff.ts` `parsePatch` + `anchors`), `CommentCard` (keep/edit/drop through RPC `inbox.review_comment` → `updateComment`), `Markdown` (Paseo’s shared `@getpaseo/plugin/client/ui` renderer). PR body and file patches come from RPC `inbox.pr_get` → `PrDetailsCache` (`gh api pulls/N` + `/files --paginate --slurp`, cached per head SHA). Screens get no `openScreen` prop, so `client/nav.ts` holds the client's.
- Search and dismissed drafts: the link field doubles as search (`matchesQuery`; a PR link matches that PR, so settled runs show too). `view().drafts` lists settled runs whose draft is still on disk (`hasDraft`), so `opensReview` opens them; RPC `inbox.restore` (`Inbox.restore`) undoes Dismiss for an unposted draft.
- `client/`: `InboxScreen` (grouped runs, actions), `useInbox` (RPC polling); `index.client.tsx` registers the screen and a sidebar row with the needs-decision count, which skips runs in snoozed workspaces (`client/snoozed.ts` observes `paseo.workspaces`, `shared/snooze.ts` keeps the ids; hosts without snooze omit `snoozedAt`).

- Settings: `shared/settings.ts` (`defineSettings`, schema = `ConfigSchema`), registered on the server (read + subscribe only; servers can't write). `client/SettingsScreen.tsx` is under Settings → Plugins → paseo-inbox. Settings win once they hold sources or rules, otherwise `inbox.json`. The screen imports it.
- Trust: `shared/trust.ts` (`parseTrust`, `decideTrust`, `untrustedAllows`), membership via `GithubMembership`. Untrusted = `modeId: "default"` + `permissionAnswer` (server/tools.ts) denying all but reads and inbox tools + credential-free env in `session_open`.
- `inbox_pr` (`prContext`): description, diff, others' threads with ids. Comments carry `raised` (thread id) and `reply`. `composeReview` holds back raised comments, and `postDraft` posts replies after the review.
- Re-reviews: `shared/rereview.ts` (`reanchorDraft` = Cerber §13.3 exact-text matching, anchors kept on the comment so later moves match the same code; `sinceBase`/`sinceChanges`; `askedAgain`) + `server/rereview.ts` (`reanchorRun` moves the run to the live head via `moveRun`; `sinceRun` uses `compareCommits`). Reopen (`reopenable`/`reopen` in `shared/inbox.ts`) runs in `Inbox.reopenAsked` after each plan, gated per run by the PR's `updatedAt`. A second run at the same head has `round` and id suffix `|r2`; the review file name carries it.
- Handoff (`handoffDraft`), preview and body override (`previewDraft`, `bodyOverride`), pasted PRs (`Inbox.addManual`, source "manual"), the review composer pill on each inbox agent's chat (`reviewPill` in `shared/inbox.ts`, `client/reviewPills.ts`; it replaced the "Open review" timeline card, whose renderer `client/ReviewCard.tsx` stays for older chats).

Render Markdown through `@getpaseo/plugin/client/ui`. Use `afterBlock` source ranges for document comments; do not add a plugin parser or renderer.

## Load-bearing facts (Paseo 0.12)

- The plugin has no `paseo` handle until a hook or RPC hands one over; polling runs without it, dispatch waits (`ready`).
- A permission hook only fires in asking modes: trusted runs use `mode` (default `auto`) so they never stall on a prompt; untrusted runs use `default` so the hook can gate every tool.
- No PATH guard: in trusted runs it was bypassable (auto mode + real `gh` login) and it blocked writes the human asked for via an ask's Send. Reviews still post through a plugin RPC behind the Post button.
- A GitHub rate limit on agent start keeps the run queued. The daemon's checkout-pr GraphQL call is the first thing to hit the limit.
- `checkout-pr` makes a new worktree per run (`<branch>-N`); Dismiss archives them via `paseo.workspaces.archive`.
- `checkout-pr` gets `projectPath: pr.repo` (`prWorktree`). Without it the daemon resolves the repo with `gh repo view`, which prefers an `upstream` remote, so a clone whose `upstream` is another project looks the PR up there. SDK 0.15.3's type lacks the field; FSH Paseo reads it.
- Runs start in background workspaces (hidden from the sidebar and from other plugins' default agent lists). A turn that starts after the run's own is the human taking over, so `turnStarted` un-hides the workspace with `setBackground(false)`. Only FSH Paseo has it (`features.workspaceBackgroundSet`); elsewhere the call is skipped.
- FSH Paseo doesn't notify when a turn finishes in a background workspace, so the plugin sends the notifications: `notifyDraftReady` (opens the review) and `notifyRunEnded` (no draft, opens the Inbox; not for canceled turns).

## Commands

- `npm run typecheck`, `npm test`.
- After edits: `paseo plugin reload paseo-inbox`; `paseo plugin ls` must say `running`; logs: `paseo plugin logs paseo-inbox`. Never restart the daemon.
- UI check without the daemon password: `scripts/ui-sandbox.sh start|stop`, which copies `plugin-data/inbox` to `/tmp/inbox-ui`, write its `config.json` (listen `127.0.0.1:6790`, CORS `http://127.0.0.1:6767`, `pluginsEnabled`, and no `inbox.json`), run `paseo daemon run --home /tmp/inbox-ui`, install the plugin with `--home`, then open `http://127.0.0.1:6767` in Playwright and use Direct connection to `127.0.0.1:6790`.
- Live check: a temporary `inbox.json` with one `once` rule on your own PR and harmless commands (`gh pr comment 999999`, `git push --dry-run`); delete the agent, its worktree, and the config afterwards.
