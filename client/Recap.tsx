import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import { ADDRESSED_LABEL, lookLabel, REVIEW_STATE, STATUS_LABEL, triage, type Recap, type ThreadStatus } from "../shared/recap";
import type { RecapInput } from "../shared/review";
import { agoText, Chip, MONO, Pill } from "./ui";

export const SINCE_FROM = { draft: "this draft's commit", reviewed: "the commit the summary was written for", posted: "your last review" } as const;

/** Worth a block of its own: there's something about the last review to say beyond the Since tab's diff. */
export const showsRecap = (recap: Recap | null, ai: RecapInput | null): recap is Recap =>
  Boolean(recap && recap.since.kind !== "none" && (recap.reviews.length || recap.comments.length || ai || recap.since.kind === "rewritten" || recap.error));

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * "Since your review", ahead of the summary on a re-review: what changed since, the reviewer's call on
 * how much to re-read, the human's past reviews, what happened to each of their comments, and the other
 * changes sorted by risk.
 */
export function RecapView({ recap, ai, theme, onOpen, onSince, onFiles }: { recap: Recap; ai: RecapInput | null; theme: PluginTheme; onOpen: (url: string) => void; onSince: () => void; onFiles: () => void }) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const label = { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, letterSpacing: 0.5 };
  const { since } = recap;
  if (since.kind === "none") return null;
  const base = since.base.slice(0, 7);
  const statusColor: Record<ThreadStatus, string> = { fixed: theme.colors.statusSuccess, "pushed-back": theme.colors.statusWarning, unanswered: theme.colors.statusDanger, outdated: theme.colors.foregroundMuted };
  const addressedColor = { yes: theme.colors.statusSuccess, partly: theme.colors.statusWarning, no: theme.colors.statusDanger } as const;
  const counts = (Object.keys(STATUS_LABEL) as ThreadStatus[]).map((status) => [status, recap.comments.filter((comment) => comment.status === status).length] as const).filter(([, count]) => count);
  const changes = triage(ai?.changes ?? []);

  return (
    <View style={{ gap: 10, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 12 }}>
      <Text style={label}>SINCE YOUR REVIEW</Text>
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
            {since.kind === "same" ? `No new commits since ${SINCE_FROM[since.from]}` : `${plural(since.commits.length, "commit")}, ${plural(since.files.length, "file")} since ${SINCE_FROM[since.from]}`} ({base}
            {since.at ? `, ${agoText(since.at)}` : ""}).
          </Text>
          {since.kind === "changes" ? <Chip theme={theme} label={`Since ${base}`} onPress={onSince} /> : null}
        </View>
      )}

      {ai ? (
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <Pill theme={theme} color={ai.look === "full" ? theme.colors.statusWarning : theme.colors.statusSuccess}>
              {lookLabel(ai)}
            </Pill>
            {ai.why ? <Text style={{ color: theme.colors.foreground, fontSize: 14, flex: 1, minWidth: 200 }}>{ai.why}</Text> : null}
          </View>
          {ai.look === "check"
            ? ai.check.map((item, index) => (
                <Text key={index} style={{ color: theme.colors.foreground, fontSize: 14 }}>
                  • {item}
                </Text>
              ))
            : null}
        </View>
      ) : null}

      {recap.reviews.length ? (
        <View style={{ gap: 4 }}>
          <Text style={label}>YOUR REVIEWS</Text>
          {recap.reviews.map((review) => (
            <Pressable key={review.id} accessibilityRole="link" onPress={() => onOpen(review.url)}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
                {REVIEW_STATE[review.state] ?? review.state.toLowerCase()} · {plural(review.comments, "comment")} · {agoText(review.at)} · <Text style={{ fontFamily: MONO, color: theme.colors.foregroundMuted }}>{review.commit.slice(0, 7)}</Text> ↗
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {recap.comments.length ? (
        <View style={{ gap: 8 }}>
          <Text style={label}>
            YOUR COMMENTS <Text style={{ fontWeight: "400", letterSpacing: 0 }}>{counts.map(([status, count]) => `${count} ${STATUS_LABEL[status].toLowerCase()}`).join(", ")}</Text>
          </Text>
          {recap.comments.map((comment) => {
            const verdict = ai?.comments.find((item) => item.thread === comment.thread);
            return (
              <Pressable key={comment.thread} accessibilityRole="link" onPress={() => onOpen(comment.url)} style={{ gap: 3 }}>
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
                  <Text style={{ ...muted, fontFamily: MONO, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                    {comment.path}
                    {comment.line ? `:${comment.line}` : ""}
                  </Text>
                </View>
                <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={2}>
                  {comment.body}
                </Text>
                {verdict?.note ? <Text style={muted}>{verdict.note}</Text> : null}
                {comment.reply ? (
                  <Text style={muted} numberOfLines={2}>
                    @{comment.reply.author}: {comment.reply.body.replace(/\s+/g, " ")}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {changes.length ? (
        <View style={{ gap: 6 }}>
          <Text style={label}>OTHER CHANGES</Text>
          {changes.map((change, index) => (
            <View key={change.path + index} style={{ gap: 2 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Pill theme={theme} color={change.risk === "logic" ? theme.colors.statusWarning : theme.colors.foregroundMuted} outlined={change.risk === "mechanical"}>
                  {change.risk === "logic" ? "Logic" : "Mechanical"}
                </Pill>
                <Text style={{ ...muted, fontFamily: MONO, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                  {change.path}
                </Text>
              </View>
              {change.note ? <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>{change.note}</Text> : null}
            </View>
          ))}
        </View>
      ) : null}

      {recap.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{recap.error}</Text> : null}
    </View>
  );
}
