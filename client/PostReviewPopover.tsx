import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { effectiveVerdict, postSummary, verdictMismatch, type PostSummary, type PrFile, type ReviewDraft } from "../shared/review";
import { Chip, verdictColor } from "./ui";

/** The run the agent's pill can post, while it has one. One object per change, so it is a stable snapshot. */
export type PostTarget = { runId: string; itemKey: string };

/** The pills module's state and actions, as the popover sees them. */
export interface PostStore {
  targetFor(agentId: string): PostTarget | undefined;
  subscribe(listener: () => void): () => void;
  draft(runId: string): Promise<ReviewDraft | null>;
  /** The PR's changed files at `version` with their patches, to tell which comments can sit on a line. */
  files(itemKey: string, version: string): Promise<readonly PrFile[]>;
  post(runId: string): Promise<void>;
}

type Loaded = {
  draft: ReviewDraft;
  /** `folded` is null while the PR's files couldn't be read. */
  summary: PostSummary;
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function load(store: PostStore, target: PostTarget): Promise<Loaded | null> {
  const draft = await store.draft(target.runId);
  if (!draft) return null;
  const summary = postSummary(draft, null);
  if (!summary.posted) return { draft, summary: { ...summary, folded: 0 } };
  // Posting re-reads the files and refuses when it can't, so a failed read here only hides the count.
  const files = await store.files(target.itemKey, draft.version).catch(() => null);
  return { draft, summary: files ? postSummary(draft, files) : summary };
}

/**
 * The confirm behind the pill's Post item: what goes out (verdict, comments, which of them land in the
 * review body, the verdict-vs-findings warning), then Post or Cancel. Changing the verdict or the
 * comments stays on the review screen.
 */
export function makePostPopover(store: PostStore): ComponentType<PluginButtonContentProps> {
  return function PostReviewPopover(props: PluginButtonContentProps) {
    const agentId = props.context === "agent" ? props.agentId : null;
    const target = useSyncExternalStore(store.subscribe, () => (agentId ? store.targetFor(agentId) : undefined));
    const styles = useMemo(() => makeStyles(props.theme, props.layout.compact), [props.theme, props.layout.compact]);
    const [loaded, setLoaded] = useState<Loaded | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [posting, setPosting] = useState(false);

    useEffect(() => {
      if (!target) return;
      let current = true;
      setLoaded(null);
      setError(null);
      load(store, target).then(
        (result) => {
          if (!current) return;
          if (result) setLoaded(result);
          else setError("This review has no draft any more.");
        },
        (caught: unknown) => current && setError(message(caught)),
      );
      return () => {
        current = false;
      };
    }, [target]);

    if (!target) return <Text style={styles.muted}>Nothing to post.</Text>;
    if (error && !loaded) return <Text style={styles.danger}>{error}</Text>;
    if (!loaded) return <ActivityIndicator color={props.theme.colors.foregroundMuted} />;

    const { draft, summary } = loaded;
    const { posted, folded, replies, held, dropped } = summary;
    const verdict = effectiveVerdict(draft);
    const mismatch = verdictMismatch(draft);
    const post = async () => {
      setPosting(true);
      setError(null);
      try {
        await store.post(target.runId);
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
          {posted} comment{posted === 1 ? "" : "s"}
          {replies ? ` · ${replies} repl${replies === 1 ? "y" : "ies"} in existing threads` : ""}
          {held ? ` · ${held} already raised, held back` : ""}
          {dropped ? ` · ${dropped} dropped` : ""}
          {draft.bodyOverride !== undefined ? " · your edited body" : ""}
        </Text>
        {folded ? (
          <Text style={styles.warning}>
            {folded === posted ? (posted === 1 ? "It goes" : "They all go") : `${folded} of them go${folded === 1 ? "es" : ""}`} in the review body, not on a line of the diff.
          </Text>
        ) : null}
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
