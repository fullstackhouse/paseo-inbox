import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { effectiveVerdict, verdictMismatch, type ReviewDraft } from "../shared/review";
import { Chip, verdictColor } from "./ui";

/** The pills module's state and actions, as the popover sees them. */
export interface PostStore {
  /** The run whose draft the agent's Post pill posts, while it has one. */
  runFor(agentId: string): string | undefined;
  subscribe(listener: () => void): () => void;
  draft(runId: string): Promise<ReviewDraft | null>;
  post(runId: string): Promise<void>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The Post pill's confirm: what goes out (verdict, comments, the verdict-vs-findings warning), then
 * Post or Cancel. Changing the verdict or the comments stays on the review screen.
 */
export function makePostPopover(store: PostStore): ComponentType<PluginButtonContentProps> {
  return function PostReviewPopover(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const runId = useSyncExternalStore(store.subscribe, () => (agentId ? store.runFor(agentId) : undefined));
    const styles = useMemo(() => makeStyles(props.theme, props.layout.compact), [props.theme, props.layout.compact]);
    const [draft, setDraft] = useState<ReviewDraft | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [posting, setPosting] = useState(false);

    useEffect(() => {
      if (!runId) return;
      let current = true;
      setDraft(null);
      setError(null);
      store.draft(runId).then(
        (loaded) => current && setDraft(loaded),
        (caught: unknown) => current && setError(message(caught)),
      );
      return () => {
        current = false;
      };
    }, [runId]);

    if (!runId) return <Text style={styles.muted}>Nothing to post.</Text>;
    if (error && !draft) return <Text style={styles.danger}>{error}</Text>;
    if (!draft) return <ActivityIndicator color={props.theme.colors.foregroundMuted} />;

    const verdict = effectiveVerdict(draft);
    const live = draft.comments.filter((comment) => comment.status !== "dropped").length;
    const dropped = draft.comments.length - live;
    const mismatch = verdictMismatch(draft);
    const post = async () => {
      setPosting(true);
      setError(null);
      try {
        await store.post(runId);
        props.close();
      } catch (caught) {
        setError(message(caught));
        setPosting(false);
      }
    };

    return (
      <View style={styles.popover}>
        <Text style={styles.title}>
          Post the review as <Text style={{ color: verdictColor(props.theme, verdict), fontWeight: "600" }}>{verdict}</Text>?
        </Text>
        <Text style={styles.muted}>
          {live} comment{live === 1 ? "" : "s"}
          {dropped ? ` · ${dropped} dropped` : ""}
          {draft.bodyOverride !== undefined ? " · your edited body" : ""}
        </Text>
        {mismatch ? <Text style={styles.warning}>{mismatch}.</Text> : null}
        {error ? <Text style={styles.danger}>{error}</Text> : null}
        <Text style={styles.muted}>To change the verdict or the comments, open the review.</Text>
        <View style={styles.actions}>
          <Chip theme={props.theme} label="Cancel" disabled={posting} onPress={props.close} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Post the review to GitHub as ${verdict}`}
            disabled={posting}
            onPress={() => void post()}
            style={[styles.post, { backgroundColor: verdictColor(props.theme, verdict), opacity: posting ? 0.5 : 1 }]}
          >
            <Text style={styles.postText}>{posting ? "Posting…" : `Post as ${verdict}`}</Text>
          </Pressable>
        </View>
      </View>
    );
  };
}

function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    // The host popover pads, scrolls and caps its size; sizing it here again clips it.
    popover: { gap: 8, minWidth: compact ? undefined : 300 },
    title: { color: colors.foreground, fontSize: 14 },
    muted: { color: colors.foregroundMuted, fontSize: 12 },
    warning: { color: colors.statusWarning, fontSize: 12 },
    danger: { color: colors.statusDanger, fontSize: 12 },
    actions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, alignItems: "center" as const, gap: 8, marginTop: 4 },
    post: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
    postText: { color: colors.accentForeground, fontWeight: "600" as const, fontSize: 13 },
  };
}
