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

`~/.paseo/inbox.json` (re-read on every poll, no reload needed):

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

## Review drafts

Inbox agents get one MCP tool, `inbox_review_draft`. It takes a verdict, a confidence (0–100), a markdown summary, optional chapters, and inline comments on lines of the diff. The draft is saved under `~/.paseo/plugin-data/inbox/reviews/`, and the run moves to **Needs a decision**. On the inbox card, **Read draft** shows the summary and comments. **Post review** asks you to confirm, then the plugin itself posts the review to GitHub. If the PR has new commits since the draft, Post is refused: rerun to draft again. A full review screen with per-comment editing comes next (SPEC-048 step 7).

## The write guard

Agents the inbox starts get `gh` and `git` shims first on their `PATH`. They pass reads (`gh pr view|diff|checks|checkout`, `gh search`, `gh api` with GET or a GraphQL query) and refuse writes (`gh pr review|comment|merge|edit`, `gh issue create`, `gh api` POST/PATCH/DELETE, GraphQL mutations, `git push`). A refused command tells the agent to put it in an ask instead. An ask's Send button only sends a prompt back to the same guarded agent, so for reviews the write happens through the inbox card's **Post review** button, which the plugin runs outside the guard. The prompt preamble says the same. This guards against accidents, not against an agent that deliberately calls `/opt/homebrew/bin/gh`.

## The inbox screen

Runs are grouped as **Needs a decision**, Running, Queued, No local checkout, Failed, Stale, Done, and Skipped. Each one has **Open agent**, **PR**, **Run now / Rerun**, and **Dismiss**. Dismiss also archives the run's workspaces and worktrees.

State lives in `~/.paseo/plugin-data/inbox/state.json`. Override paths with `PASEO_INBOX_CONFIG` and `PASEO_INBOX_DIR`.
