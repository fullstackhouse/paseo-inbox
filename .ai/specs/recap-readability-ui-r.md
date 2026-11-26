# Recap readability — the panel

## Area-wide

- Lives in the review pane: about 1000 px wide on desktop beside the chat, 390 px on a phone
  sheet. Same dark card (`surface1`, 10 px radius) as today.
- Read order: how much to re-read → your reviews → what happened to your comments → logic
  changes → mechanical changes. Colour only for status; everything else is foreground or muted.
- Every block after the header starts with a hairline rule and a small caps title, with its
  count after a middle dot, so the blocks stop running together.
- Tapping a comment or a review opens it on GitHub; "Since 3cfa72c" opens the Since tab.

## R1 Since your review (P1)

- **Short.** What changed since your last review, and what to re-read.
- **Change.** Changed — a rule and title open each block; each comment gets a left edge in its status colour, and the reviewer's note and the author's reply are labelled; logic changes lose their per-row Logic pill; mechanical changes fold into one line of file names behind "Show mechanical changes"; the reviewer's call (Full re-look / Check N things) sits on its own line above its reason.
- **Extended.** Shown on a re-review once the live head is known. The header says how many
  commits and files since the base, with a chip into the Since tab. The reviewer's call follows
  as a pill with its reason, or the list of things to check. Your comments come with GitHub's
  status (Fixed, Pushed back, Unanswered, Outdated, Unknown), the reviewer's Addressed verdict,
  its note, and the last reply from someone else. Logic changes list path then note.
  Mechanical changes stay folded unless you ask: they are safe to skim and were most of the rows.
- **Get here.** Review screen → Summary, on a run that is a re-review.
- **Shows.** Title "SINCE YOUR REVIEW"; "2 commits, 15 files since your last review (3cfa72c, 3h ago)." with a "Since 3cfa72c" chip; the look pill and reason; YOUR REVIEWS; YOUR COMMENTS · 1 fixed; OTHER CHANGES · 6 logic changes; MECHANICAL · 7 files.
- **Variants.** Full re-look with one fixed comment, logic and mechanical changes (the PR in the report); the same with mechanical changes shown; Check N things with an unanswered and a pushed-back comment; no new commits; the reviewer hasn't written its verdicts yet; phone width.
- **Edge cases.** Force-pushed or rebased branch → "The branch was force-pushed or rebased since your last review (3cfa72c), so there's no clean diff of what changed. Review it in full." with Open Files. Over 300 changed files → "GitHub lists at most 300 changed files and the full list couldn't be read, so 1 comment is marked unknown: check it in the diff." GitHub unreadable → the since line and the look stay, reviews and comment statuses go, and the panel ends in red with "Couldn't read your earlier comments: <GitHub's error>".

## Decisions (R, 2026-11-26)

1. Mechanical changes fold into one line of file names by default; "Show mechanical changes" expands them in place (R1-s1, R1-s2).
