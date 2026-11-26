import type { PluginTheme } from "@getpaseo/plugin";
import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { ADDRESSED_LABEL, lookLabel, preview, REVIEW_STATE, splitPath, STATUS_LABEL, type Recap, type ThreadStatus } from "../shared/recap";
import type { RecapInput } from "../shared/review";
import { agoText, Chip, MONO, Pill } from "./ui";

export const SINCE_FROM = { draft: "this draft's commit", reviewed: "the commit the summary was written for", posted: "your last review" } as const;

/** Worth a block of its own: there's something about the last review to say beyond the Since tab's diff. */
export const showsRecap = (recap: Recap | null, ai: RecapInput | null): recap is Recap =>
  Boolean(recap && recap.since.kind !== "none" && (recap.reviews.length || recap.comments.length || ai || recap.since.kind === "rewritten" || recap.error));

/**
 * A path on one line that keeps the file name and line in view on narrow screens: the folders shrink
 * and clip, the name doesn't.
 */
function FilePath({ path, line, color }: { path: string; line: number | null; color: string }) {
  const { dir, name } = splitPath(path);
  const style = { color, fontFamily: MONO, fontSize: 12 };
  return (
    <View style={{ flexDirection: "row", flexShrink: 1, minWidth: 0 }}>
      {dir ? (
        <Text style={{ ...style, flexShrink: 1 }} numberOfLines={1}>
          {dir}
        </Text>
      ) : null}
      <Text style={{ ...style, flexShrink: 0 }} numberOfLines={1}>
        {name}
        {line ? `:${line}` : ""}
      </Text>
    </View>
  );
}

/** A titled part of the recap, set off from the one above by a rule so the parts don't run together. */
function Section({ title, extra, theme, children }: { title: string; extra?: string; theme: PluginTheme; children: ReactNode }) {
  return (
    <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.5 }}>
        {title}
        {extra ? <Text style={{ fontWeight: "400", letterSpacing: 0 }}> · {extra}</Text> : null}
      </Text>
      {children}
    </View>
  );
}

/** One changed file: its path, then the reviewer's note under it. */
function ChangeRow({ path, note, theme }: { path: string; note?: string; theme: PluginTheme }) {
  return (
    <View style={{ gap: 2 }}>
      <FilePath path={path} line={null} color={theme.colors.foregroundMuted} />
      {note ? <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{note}</Text> : null}
    </View>
  );
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * "Since your review", ahead of the summary on a re-review: what changed since, the reviewer's call on
 * how much to re-read, the human's past reviews, what happened to each of their comments, and the other
 * changes sorted by risk.
 */
export function RecapView({ recap, ai, theme, onOpen, onSince, onFiles }: { recap: Recap; ai: RecapInput | null; theme: PluginTheme; onOpen: (url: string) => void; onSince: () => void; onFiles: () => void }) {
  const [showMechanical, setShowMechanical] = useState(false);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const { since } = recap;
  if (since.kind === "none") return null;
  const base = since.base.slice(0, 7);
  const statusColor: Record<ThreadStatus, string> = { fixed: theme.colors.statusSuccess, "pushed-back": theme.colors.statusWarning, unanswered: theme.colors.statusDanger, outdated: theme.colors.foregroundMuted, unknown: theme.colors.foregroundMuted };
  const unknown = recap.comments.filter((comment) => comment.status === "unknown").length;
  const partial = since.kind === "changes" && since.incomplete;
  const addressedColor = { yes: theme.colors.statusSuccess, partly: theme.colors.statusWarning, no: theme.colors.statusDanger } as const;
  const counts = (Object.keys(STATUS_LABEL) as ThreadStatus[]).map((status) => [status, recap.comments.filter((comment) => comment.status === status).length] as const).filter(([, count]) => count);
  const logic = ai?.changes.filter((change) => change.risk === "logic") ?? [];
  const mechanical = ai?.changes.filter((change) => change.risk === "mechanical") ?? [];

  return (
    <View style={{ gap: 12, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 12 }}>
      <View style={{ gap: 10 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.5 }}>SINCE YOUR REVIEW</Text>
        {since.kind === "rewritten" ? (
          <View style={{ gap: 8, alignItems: "flex-start" }}>
            <Text style={{ color: theme.colors.statusWarning, fontSize: 14 }}>
              The branch was force-pushed or rebased since {SINCE_FROM[since.from]} ({base}), so there's no clean diff of what changed. Review it in full.
            </Text>
            <Chip theme={theme} label="Open Files" onPress={onFiles} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Text style={{ ...muted, flex: 1, minWidth: 200 }}>
              {since.kind === "same" ? `No new commits since ${SINCE_FROM[since.from]}` : `${plural(since.commits.length, "commit")}, ${partial ? "at least " : ""}${plural(since.files.length, "file")} since ${SINCE_FROM[since.from]}`} ({base}
              {since.at ? `, ${agoText(since.at)}` : ""}).
            </Text>
            {since.kind === "changes" ? <Chip theme={theme} label={`Since ${base}`} onPress={onSince} /> : null}
          </View>
        )}

        {partial || unknown ? (
          <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>
            GitHub lists at most 300 changed files and the full list couldn't be read
            {unknown ? `, so ${unknown === 1 ? "1 comment is" : `${unknown} comments are`} marked unknown: check ${unknown === 1 ? "it" : "them"} in the diff` : ""}.
          </Text>
        ) : null}

        {ai ? (
          <View style={{ gap: 6, alignItems: "flex-start" }}>
            <Pill theme={theme} color={ai.look === "full" ? theme.colors.statusWarning : theme.colors.statusSuccess}>
              {lookLabel(ai)}
            </Pill>
            {ai.why ? <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{ai.why}</Text> : null}
            {ai.look === "check"
              ? ai.check.map((item, index) => (
                  <Text key={index} style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>
                    • {item}
                  </Text>
                ))
              : null}
          </View>
        ) : null}
      </View>

      {recap.reviews.length ? (
        <Section title="YOUR REVIEWS" theme={theme}>
          {recap.reviews.map((review) => (
            <Pressable key={review.id} accessibilityRole="link" onPress={() => onOpen(review.url)}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                {REVIEW_STATE[review.state] ?? review.state.toLowerCase()} · {plural(review.comments, "comment")} · {agoText(review.at)} · <Text style={{ fontFamily: MONO, color: theme.colors.foregroundMuted }}>{review.commit.slice(0, 7)}</Text> ↗
              </Text>
            </Pressable>
          ))}
        </Section>
      ) : null}

      {recap.comments.length ? (
        <Section title="YOUR COMMENTS" extra={counts.map(([status, count]) => `${count} ${STATUS_LABEL[status].toLowerCase()}`).join(", ")} theme={theme}>
          {recap.comments.map((comment) => {
            const verdict = ai?.comments.find((item) => item.thread === comment.thread);
            return (
              <Pressable key={comment.thread} accessibilityRole="link" onPress={() => onOpen(comment.url)} style={{ gap: 6, borderLeftWidth: 2, borderLeftColor: statusColor[comment.status], paddingLeft: 10 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <Pill theme={theme} color={statusColor[comment.status]}>
                    {STATUS_LABEL[comment.status]}
                    {comment.why === "resolved" ? " · resolved" : comment.why === "changed" ? " · code changed" : ""}
                  </Pill>
                  {verdict ? (
                    <Pill theme={theme} color={addressedColor[verdict.addressed]} outlined>
                      {ADDRESSED_LABEL[verdict.addressed]}
                    </Pill>
                  ) : null}
                  <FilePath path={comment.path} line={comment.line} color={theme.colors.foregroundMuted} />
                </View>
                <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }} numberOfLines={2}>
                  {preview(comment.body)}
                </Text>
                {verdict?.note ? (
                  <Text style={{ ...muted, lineHeight: 18 }}>
                    <Text style={{ fontWeight: "600" }}>Reviewer: </Text>
                    {verdict.note}
                  </Text>
                ) : null}
                {comment.reply ? (
                  <Text style={{ ...muted, lineHeight: 18 }} numberOfLines={2}>
                    <Text style={{ fontWeight: "600" }}>@{comment.reply.author}: </Text>
                    {preview(comment.reply.body)}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </Section>
      ) : null}

      {logic.length ? (
        <Section title="OTHER CHANGES" extra={`${plural(logic.length, "logic change")}`} theme={theme}>
          {logic.map((change, index) => (
            <ChangeRow key={change.path + index} path={change.path} note={change.note} theme={theme} />
          ))}
        </Section>
      ) : null}

      {mechanical.length ? (
        <Section title={logic.length ? "MECHANICAL" : "OTHER CHANGES"} extra={plural(mechanical.length, "file")} theme={theme}>
          {showMechanical ? (
            mechanical.map((change, index) => <ChangeRow key={change.path + index} path={change.path} note={change.note} theme={theme} />)
          ) : (
            <Text style={{ ...muted, lineHeight: 18 }} numberOfLines={2}>
              {mechanical.map((change) => splitPath(change.path).name).join(", ")}
            </Text>
          )}
          <Pressable accessibilityRole="button" onPress={() => setShowMechanical((shown) => !shown)} hitSlop={6} style={{ alignSelf: "flex-start" }}>
            <Text style={{ color: theme.colors.accent, fontSize: 13 }}>{showMechanical ? "Hide" : "Show"} mechanical changes</Text>
          </Pressable>
        </Section>
      ) : null}

      {recap.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{recap.error}</Text> : null}
    </View>
  );
}
