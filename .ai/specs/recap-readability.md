# Recap readability

The "Since your review" panel on a re-review (`client/Recap.tsx`) is hard to scan: every row has
the same weight and spacing, the section labels are small muted caps, each of a dozen changed
files carries its own Logic/Mechanical pill, and the reviewer's note and the author's reply under
a comment are two indistinguishable grey lines.

Goal: a reviewer coming back to a PR sees, in this order and at a glance, how much to re-read,
what happened to each of their comments, and which other changes are logic worth reading.

Scope: layout and hierarchy of the panel only. The data (`Recap`, `RecapInput`) and the
reviewer's prompt stay as they are.

UI: [map](./recap-readability-ui-map.md), [the panel](./recap-readability-ui-r.md).
