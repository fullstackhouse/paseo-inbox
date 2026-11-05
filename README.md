# paseo-inbox

A [Paseo](https://paseo.sh) plugin that turns PR chores into a rule-driven inbox. It polls
GitHub PR searches, matches each PR against your rules, and starts one agent per match:
draft a review, QA a UI change with screenshots, propose a fix for red CI. Agents it starts
**cannot write to GitHub**. They end with an ask whose Send button carries the write, so
nothing is posted until you click.

Design: [SPEC-048](https://github.com/fullstackhouse/fsh-monorepo/blob/main/docs/specs/SPEC-048-2026-10-29-paseo-inbox.md).

## Install

```bash
git clone https://github.com/fullstackhouse/paseo-inbox && cd paseo-inbox && npm ci
paseo plugin install "$PWD"
```

Paseo shows an **Inbox** row in the sidebar. It does nothing until you write `~/.paseo/inbox.json`.

## Configure

**Settings → Plugins → paseo-inbox → Inbox** (or "Inbox settings" in the Command Center). The settings live in Paseo's own store on the host:
- **Running**, how often to check GitHub, how many reviewers run at once, the model, and the mode.
- **Trust** rules.
- Local checkouts, one per line.
- Sources and rules, as JSON.

Until settings hold any sources or rules, a legacy `~/.paseo/inbox.json` applies, and the screen offers to import it. The shape is the same:

```jsonc
{
  "pollSeconds": 300,          // min 60
  "maxConcurrent": 2,          // agents running at once
  "provider": "claude/claude-opus-5-5", // provider/model; `paseo provider models claude`
  "mode": "auto",              // provider mode for unattended runs (Claude: auto)
  "checkouts": { "acme/shop": "~/src/shop" },
  "sources": {
    "review-requested": { "github": "is:open review-requested:@me" },
    "mine":             { "github": "is:open author:@me" },
    "needs-qa":         { "github": "is:open label:needs-qa org:acme" }
  },
  "rules": [
    { "name": "draft-review", "source": "review-requested", "rerun": "on-push",
      "prompt": "Review {{pr.url}}: read the diff and the code around it, then save your review with inbox_review_draft." },
    { "name": "qa-screenshots", "source": "needs-qa", "paths": ["**/*.tsx", "packages/ui/src/**"],
      "prompt": "/om-auto-qa-pr {{pr.number}}" },
    { "name": "fix-red-ci", "source": "mine", "when": { "checks": "failing" }, "rerun": "once",
      "prompt": "Diagnose the failing CI on {{pr.url}} and propose a fix." }
  ]
}
```

- **Sources** are `gh search prs` queries.
- **Rules**: per source, the first rule whose filters match wins. Filters are `paths` (globs over changed files), `labels` (all required), `draft`, and `when.checks` (`passing`, `failing`, `pending`, `none`).
- **`rerun`**: `on-push` runs again for each new head SHA, `once` runs once per PR, and `manual` only runs from **Run now**.
- **Placeholders**: `{{pr.url}}`, `{{pr.number}}`, `{{pr.repo}}`, `{{pr.title}}`, `{{pr.headSha}}`.
- **Checkouts**: each run gets a fresh worktree of the PR, made from the local checkout listed in `checkouts`. A PR in a repo without one shows as **No local checkout**.
- **Workspaces**: runs start hidden from the sidebar. Once you take one over (send its agent a message, press an ask's button, or "Ask about this"), its workspace moves into the sidebar. That needs a Paseo host with `workspaceBackgroundSet` (the FSH build); elsewhere runs stay hidden, and the sidebar's **Show background** lists them.

## Review drafts

Inbox agents get one MCP tool, `inbox_review_draft`. It takes a verdict, a confidence (0–100), a markdown summary, optional chapters, and inline comments on lines of the diff. The draft is saved under `~/.paseo/plugin-data/inbox/reviews/`, and the run moves to **Needs a decision**. Tap a drafted row to open the **review screen**, which works on a phone and on desktop:

- **Header:** the PR's repo and number, title, author, branch → base, head SHA, size, the verdict with confidence, plus **GitHub ↗** and **Ask the reviewer**. Ask the reviewer opens the agent that wrote the draft, so you can argue with it or have it redraft. A redraft replaces your edits.
- **Tabs:** Summary, Walkthrough (the reviewer's chapters with their files), Files (every file with its diff and the drafted comments under their lines, plus Expand all, Collapse all and Only commented), Description (the author's PR body), and Comments.
- **Comments:** each one can be kept, edited, dropped or restored.
- **Moving between drafts:** ‹ › steps through the other drafts waiting for you.
- **Reading:** syntax colours in diffs. A markdown file the PR adds opens as a document, with comments under their paragraphs (Diff is one tap away). Markdown tables render. Each file has a Viewed box, which unticks if the file changes; "Not viewed" opens only the files you haven't seen. Tapping a comment's path jumps to its file.
- **Your comments:** tap any diff line, or "Comment on the whole file", to add your own or to ask the reviewer about it. Regrade any comment (blocker, minor, nit, note).
- **Talking to the reviewer:** "Ask about this" sends the agent a quoted message and opens it. Its changes arrive through `inbox_review_revise`, which never touches comments you wrote or decided on.
- **Posting:** pick the verdict (a hint warns when it disagrees with the blockers still standing), then post. The bottom bar posts the review after a confirm, with the inline comments you didn't drop. If the PR has new commits since the draft, Post is refused: rerun to draft again.

## Trust

Trust decides one thing: whether a review run may execute commands. Rules name people, as Cerber's do: `@login` (a `*` glob within the name), `@org/team`, `@org/*`; a leading `!` denies. Denials win, then the first grant. No match, and no rules at all, means untrusted. Repos can't be trusted, because a repo takes PRs from anyone.

An untrusted run is **read-only**:
- It runs in Claude's asking mode, and the inbox answers every prompt: reading files and the inbox tools pass, everything else (Bash, edits, web, other MCP servers) is denied.
- Its environment holds no GitHub or git credentials and no ssh identities.

The reviewer reads the PR through `inbox_pr`: description, diff, and other reviewers' comments. This is credential hygiene, not a sandbox. The repo's own Claude hooks still run in the checkout.

## Already raised, handoff, preview, pasting a link

- **Other reviewers' comments** show in the diff where they sit. When the reviewer's finding repeats one, it's marked *already raised* and held back. "Reply in thread" posts it as a reply there instead, and "Post as new" posts it as a new comment.
- **Preview** shows exactly what Post sends: the event, the body, inline comments, replies, and what's held or folded. **Edit text** replaces the composed body until you **Reset**.
- **Hand off** requests someone else's review, withdraws yours, and leaves a note naming them. Optionally it sends your draft as a COMMENT review, never as an approval or a request for changes.
- **Paste a PR link** at the top of the Inbox to review any PR with the manual rule (`manualRule`, default the first rule).

## Notifications

On a host with plugin notifications (FSH's Paseo build, fullstackhouse/paseo#46), a draft sends **Review draft ready**, and tapping it opens the review. Repeats for the same run are merged. Settings → Plugins → paseo-inbox → "Turn off notifications" mutes it. On other hosts, Paseo's "agent finished" notification opens the reviewer's chat, where the inbox adds a **Review draft ready → Open review** card.

## The write guard

Agents the inbox starts get `gh` and `git` shims first on their `PATH`. They pass reads (`gh pr view|diff|checks|checkout`, `gh search`, `gh api` with GET or a GraphQL query) and refuse writes (`gh pr review|comment|merge|edit`, `gh issue create`, `gh api` POST/PATCH/DELETE, GraphQL mutations, `git push`). A refused command tells the agent to put it in an ask instead. An ask's Send button only sends a prompt back to the same guarded agent, so for reviews the write happens through the inbox card's **Post review** button, which the plugin runs outside the guard. The prompt preamble says the same. This guards against accidents, not against an agent that deliberately calls `/opt/homebrew/bin/gh`.

## The inbox screen

Runs are grouped as **Needs a decision**, Running, Queued, No local checkout, Failed, Stale, Done, and Skipped. Each one has **Open agent**, **PR**, **Run now / Rerun**, and **Dismiss**. Dismiss also archives the run's workspaces and worktrees.

State lives in `~/.paseo/plugin-data/inbox/state.json`. Override paths with `PASEO_INBOX_CONFIG` and `PASEO_INBOX_DIR`.
