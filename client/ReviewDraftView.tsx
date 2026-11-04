import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { draftHeadline, getReview, postReview, type ReviewDraft } from "../shared/review";

/**
 * A run's review draft on its inbox card: headline, summary, inline comments, and Post. Until the
 * review screen exists (SPEC-048 step 7) this is where a draft is read and posted.
 */
export function ReviewDraftView({ runId, theme, canPost, onPosted }: { runId: string; theme: PluginTheme; canPost: boolean; onPosted: () => void }) {
  const get = useRpc(getReview);
  const post = useRpc(postReview);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void get({ runId })
      .then((value) => live && setDraft(value))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [get, runId]);

  if (!draft) return null;
  const text = { color: theme.colors.foreground, fontSize: 14 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const button = { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 };
  const primary = { ...button, backgroundColor: theme.colors.accent };

  const submit = async () => {
    setPosting(true);
    setError(null);
    try {
      const { url } = await post({ runId });
      setDraft({ ...draft, postedUrl: url });
      onPosted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPosting(false);
      setConfirming(false);
    }
  };

  return (
    <View style={{ gap: 8, marginTop: 4 }}>
      <Text style={{ ...text, fontWeight: "600" }}>{draftHeadline(draft)}</Text>
      <Text style={text} numberOfLines={open ? undefined : 4}>
        {draft.summary}
      </Text>
      {open
        ? draft.comments.map((comment) => (
            <View key={comment.id} style={{ borderLeftWidth: 2, borderLeftColor: theme.colors.border, paddingLeft: 8, gap: 2 }}>
              <Text style={muted}>
                {comment.severity} · {comment.path}:{comment.line}
              </Text>
              <Text style={text}>{comment.body}</Text>
            </View>
          ))
        : null}
      {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Pressable accessibilityRole="button" onPress={() => setOpen(!open)} style={button}>
          <Text style={text}>{open ? "Collapse" : `Read draft (${draft.comments.length} comments)`}</Text>
        </Pressable>
        {draft.postedUrl ? (
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(draft.postedUrl!)} style={button}>
            <Text style={text}>Posted ↗</Text>
          </Pressable>
        ) : canPost ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={confirming ? "Confirm posting the review to GitHub" : "Post review"}
            disabled={posting}
            onPress={() => (confirming ? void submit() : setConfirming(true))}
            style={[primary, posting ? { opacity: 0.5 } : null]}
          >
            <Text style={{ color: theme.colors.accentForeground, fontSize: 13 }}>
              {posting ? "Posting…" : confirming ? `Post as ${draft.verdict} — sure?` : "Post review"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
