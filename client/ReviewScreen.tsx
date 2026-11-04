import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from "react-native";
import type { Run } from "../shared/inbox";
import { getPrDetails, getReview, postReview, updateReviewComment, type PrDetails, type ReviewDraft } from "../shared/review";
import { CommentCard, type CommentChange } from "./CommentCard";
import { FileDiff } from "./FileDiff";
import { Markdown } from "./Markdown";
import { ago, Chip, MONO, Pill, verdictColor } from "./ui";
import { useInbox } from "./useInbox";

export const REVIEW_SCREEN = "review";

type Tab = "summary" | "changes" | "files" | "description" | "comments";

/** Runs whose review draft is waiting for the human, newest first: the prev/next order. */
export const reviewQueue = (runs: readonly Run[]) =>
  runs.filter((run) => run.state === "needs-decision" && run.reason?.startsWith("review ")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

/**
 * The review screen: everything needed to judge a PR without leaving Paseo. A header with the PR's
 * shape and the verdict, tabs for the reviewer's summary, its walkthrough chapters, the files with
 * their diffs and the drafted comments in place, the author's description, and the comment list;
 * a bottom bar posts the review after a confirm.
 */
export function ReviewScreen({ theme, layout, navigation, params }: PluginScreenProps) {
  const { view, refresh } = useInbox();
  const [runId, setRunId] = useState(params.runId ?? "");
  useEffect(() => setRunId(params.runId ?? ""), [params.runId]);
  const run = view?.runs.find((candidate) => candidate.id === runId) ?? null;
  const pr = run ? view?.items[run.itemKey]?.pr : undefined;

  const fetchDraft = useRpc(getReview);
  const fetchDetails = useRpc(getPrDetails);
  const updateComment = useRpc(updateReviewComment);
  const post = useRpc(postReview);
  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [details, setDetails] = useState<PrDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [posting, setPosting] = useState(false);
  const scroll = useRef<ScrollView>(null);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    setDraft(null);
    setError(null);
    setTab("summary");
    setOpenFiles(new Set());
    setConfirming(false);
    void fetchDraft({ runId })
      .then((value) => live && setDraft(value))
      .catch((caught) => live && setError(String(caught?.message ?? caught)));
    return () => {
      live = false;
    };
  }, [fetchDraft, runId]);

  const itemKey = run?.itemKey;
  useEffect(() => {
    if (!itemKey) return;
    let live = true;
    setDetails(null);
    void fetchDetails({ itemKey })
      .then((value) => live && setDetails(value))
      .catch((caught) => live && setError(String(caught?.message ?? caught)));
    return () => {
      live = false;
    };
  }, [fetchDetails, itemKey]);

  const queue = useMemo(() => reviewQueue(view?.runs ?? []), [view]);
  const position = queue.findIndex((candidate) => candidate.id === runId);
  const go = (offset: number) => {
    const next = queue[position + offset];
    if (next) setRunId(next.id);
  };

  const commentsByFile = useMemo(() => {
    const map = new Map<string, ReviewDraft["comments"]>();
    for (const comment of draft?.comments ?? []) map.set(comment.path, [...(map.get(comment.path) ?? []), comment]);
    return map;
  }, [draft]);

  const editable = Boolean(draft && !draft.postedUrl && run?.state === "needs-decision" && pr?.headSha === draft.version);
  const change = useCallback(
    async (commentId: string, value: CommentChange) => {
      try {
        setDraft(await updateComment({ runId, commentId, ...value }));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [updateComment, runId],
  );

  const toggleFile = (path: string, force?: boolean) =>
    setOpenFiles((current) => {
      const next = new Set(current);
      if (force ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });
  const openFile = (path: string) => {
    toggleFile(path, true);
    setTab("files");
  };

  const submit = async () => {
    setPosting(true);
    setError(null);
    try {
      const { url } = await post({ runId });
      setDraft((current) => (current ? { ...current, postedUrl: url } : current));
      void refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPosting(false);
      setConfirming(false);
    }
  };

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const pad = layout.compact ? 14 : 24;
  const maxWidth = 980;

  if (!runId || (view && !run)) {
    return (
      <View style={{ flex: 1, padding: pad, backgroundColor: theme.colors.surface0 }}>
        <Text style={muted}>This review is no longer in the inbox.</Text>
      </View>
    );
  }
  if (!run || !pr) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface0 }}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  const live = draft?.comments.filter((comment) => comment.status !== "dropped") ?? [];
  const files = details?.files ?? [];
  const tabs: { id: Tab; label: string }[] = [
    { id: "summary", label: "Summary" },
    ...(draft?.chapters.length ? [{ id: "changes" as const, label: `Walkthrough ${draft.chapters.length}` }] : []),
    { id: "files", label: `Files ${details ? files.length : pr.files.length}` },
    { id: "description", label: "Description" },
    { id: "comments", label: `Comments ${live.length}` },
  ];
  const stale = draft ? pr.headSha !== draft.version : false;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView ref={scroll} stickyHeaderIndices={[1]} contentContainerStyle={{ paddingBottom: 24 }}>
        {/* Header */}
        <View style={{ paddingHorizontal: pad, paddingTop: pad, paddingBottom: 10, gap: 8, width: "100%", maxWidth, alignSelf: "center" }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ ...muted, flex: 1 }} numberOfLines={1}>
              {pr.repo}#{pr.number}
              {queue.length > 1 && position >= 0 ? `  ·  ${position + 1} of ${queue.length}` : ""}
            </Text>
            {queue.length > 1 ? (
              <>
                <Chip theme={theme} label="‹" accessibilityLabel="Previous review" disabled={position <= 0} onPress={() => go(-1)} />
                <Chip theme={theme} label="›" accessibilityLabel="Next review" disabled={position < 0 || position >= queue.length - 1} onPress={() => go(1)} />
              </>
            ) : null}
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "700", lineHeight: layout.compact ? 24 : 28 }}>{pr.title}</Text>
          <Text style={muted}>
            {details?.author || pr.author || "?"}
            {details ? `  ·  ${details.headRef} → ${details.baseRef}` : ""}
            {"  ·  "}
            <Text style={{ fontFamily: MONO }}>{pr.headSha.slice(0, 7)}</Text>
            {"  ·  "}
            <Text style={{ color: theme.colors.statusSuccess }}>+{details?.additions ?? pr.additions}</Text> <Text style={{ color: theme.colors.statusDanger }}>−{details?.deletions ?? pr.deletions}</Text>
            {`  ·  ${details?.changedFiles ?? pr.files.length} files`}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {draft ? (
              <Pill theme={theme} color={verdictColor(theme, draft.verdict)}>
                {draft.verdict} · {draft.confidence}%
              </Pill>
            ) : null}
            {stale ? <Pill theme={theme} color={theme.colors.statusWarning}>new commits since this draft</Pill> : null}
            {draft?.postedUrl ? <Pill theme={theme} color={theme.colors.statusSuccess}>posted</Pill> : null}
            <View style={{ flex: 1 }} />
            <Chip theme={theme} label="GitHub ↗" onPress={() => void Linking.openURL(pr.url)} />
            {run.agentId && navigation ? <Chip theme={theme} label="Ask the reviewer" onPress={() => navigation.openAgent({ agentId: run.agentId! })} /> : null}
          </View>
        </View>

        {/* Sticky tabs */}
        <View style={{ backgroundColor: theme.colors.surface0, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: pad, paddingVertical: 8, gap: 6, flexGrow: 1, justifyContent: layout.compact ? "flex-start" : "center" }}>
            {tabs.map((item) => (
              <Chip key={item.id} theme={theme} label={item.label} active={tab === item.id} onPress={() => setTab(item.id)} />
            ))}
          </ScrollView>
        </View>

        {/* Content */}
        <View style={{ paddingHorizontal: pad, paddingTop: 14, gap: 12, width: "100%", maxWidth, alignSelf: "center" }}>
          {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
          {!draft && tab !== "description" && tab !== "files" ? <Text style={muted}>No review draft for this run.</Text> : null}

          {tab === "summary" && draft ? <Markdown text={draft.summary} theme={theme} /> : null}

          {tab === "changes" && draft
            ? draft.chapters.map((chapter, index) => (
                <View key={index} style={{ gap: 8, paddingBottom: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700" }}>
                    {index + 1}. {chapter.title}
                  </Text>
                  <Markdown text={chapter.body} theme={theme} size={14} />
                  {chapter.files.map((path) => {
                    const file = files.find((candidate) => candidate.path === path);
                    return file ? (
                      <FileDiff key={path} file={file} comments={commentsByFile.get(path) ?? []} theme={theme} compact={layout.compact} open={openFiles.has(path)} onToggle={() => toggleFile(path)} editable={editable} onChange={change} />
                    ) : (
                      <Text key={path} style={muted}>{path}</Text>
                    );
                  })}
                </View>
              ))
            : null}

          {tab === "files" ? (
            details ? (
              <>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Chip theme={theme} label="Expand all" onPress={() => setOpenFiles(new Set(files.map((file) => file.path)))} />
                  <Chip theme={theme} label="Collapse all" onPress={() => setOpenFiles(new Set())} />
                  {live.length ? <Chip theme={theme} label="Only commented" onPress={() => setOpenFiles(new Set(live.map((comment) => comment.path)))} /> : null}
                </View>
                {files.map((file) => (
                  <FileDiff key={file.path} file={file} comments={commentsByFile.get(file.path) ?? []} theme={theme} compact={layout.compact} open={openFiles.has(file.path)} onToggle={() => toggleFile(file.path)} editable={editable} onChange={change} />
                ))}
              </>
            ) : (
              <ActivityIndicator color={theme.colors.foregroundMuted} />
            )
          ) : null}

          {tab === "description" ? (
            details ? (
              <>
                <Text style={muted}>
                  by {details.author} · opened {ago(details.createdAt)} ago
                </Text>
                <Markdown text={details.body} theme={theme} />
              </>
            ) : (
              <ActivityIndicator color={theme.colors.foregroundMuted} />
            )
          ) : null}

          {tab === "comments" && draft ? (
            draft.comments.length ? (
              draft.comments.map((comment) => (
                <CommentCard key={comment.id} comment={comment} theme={theme} editable={editable} onChange={(value) => change(comment.id, value)} onOpenFile={() => openFile(comment.path)} />
              ))
            ) : (
              <Text style={muted}>The reviewer left no inline comments.</Text>
            )
          ) : null}
        </View>
      </ScrollView>

      {/* Post bar */}
      {draft && !draft.postedUrl ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, backgroundColor: theme.colors.surface1, paddingHorizontal: pad, paddingVertical: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, width: "100%", maxWidth, alignSelf: "center" }}>
            <Text style={{ ...muted, flex: 1 }} numberOfLines={2}>
              {stale ? "New commits since this draft: rerun from the Inbox to re-draft." : `${draft.verdict} · ${live.length} inline comment${live.length === 1 ? "" : "s"}${draft.comments.length > live.length ? ` (${draft.comments.length - live.length} dropped)` : ""}`}
            </Text>
            {confirming ? <Chip theme={theme} label="Cancel" onPress={() => setConfirming(false)} /> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirming ? "Confirm posting the review to GitHub" : "Post review"}
              disabled={!editable || posting}
              onPress={() => (confirming ? void submit() : setConfirming(true))}
              style={{ backgroundColor: confirming ? verdictColor(theme, draft.verdict) : theme.colors.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, opacity: !editable || posting ? 0.5 : 1 }}
            >
              <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", fontSize: 14 }}>{posting ? "Posting…" : confirming ? "Post to GitHub" : "Post review"}</Text>
            </Pressable>
          </View>
        </View>
      ) : draft?.postedUrl ? (
        <Pressable onPress={() => void Linking.openURL(draft.postedUrl!)} style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, padding: 12, alignItems: "center", backgroundColor: theme.colors.surface1 }}>
          <Text style={{ color: theme.colors.statusSuccess, fontSize: 14 }}>Posted · open on GitHub ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
