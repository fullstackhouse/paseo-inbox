# Recap readability — UI map

Companion to [the spec](./recap-readability.md). One view: the "Since your review" panel on the
review screen of a re-review. The atlas draws every state of it.

Legend: **P1** = this change.

## Navigation

Inbox → a run → Review tab (or the chat's Review pill → Open review). On a re-review the panel
sits at the top of the Summary, above the draft. Nothing in the menu changes.

## Baseline

paseo-inbox main at 995087e (2026-11-26), "Since your review" recap as shipped in #61.

## Flow

```mermaid
flowchart LR
  I1[I1 Review screen] --> R1[R1 Since your review]
  R1 -->|Since 3cfa72c| I2[I2 Since tab]
  R1 -->|comment or review| G1[G1 GitHub thread]
  R1 -->|Open Files| I3[I3 Files tab]
```

## R — Review screen

Views: R1 Since your review.
