import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, View } from "react-native";
import { runNow, skipRun, type Run } from "../shared/inbox";
import {
  addReviewComment,
  deleteReviewComment,
  discussReview,
  effectiveVerdict,
  getPrDetails,
  getReview,
  placement,
  postReview,
  REVISE_TOOL,
  setReviewVerdict,
  updateReviewComment,
  VerdictSchema,
  verdictMismatch,
  walkthrough,
  type CommentChange,
  type PrDetails,
  type ReviewDraft,
  type Severity,
} from "../shared/review";
import { CommentCard } from "./CommentCard";
import { FileDiff, type DiffActions } from "./FileDiff";
import { Markdown } from "./Markdown";
import { ago, Chip, MONO, Pill, verdictColor } from "./ui";
import { useInbox } from "./useInbox";

export const REVIEW_SCREEN = "review";

type Tab = "summary" | "walkthrough" | "files" | "description" | "comments";

/** Runs whose review draft is waiting for the human, newest first: the prev/next order. */
export const reviewQueue = (runs: readonly Run[]) =>
  runs.filter((run) => run.state === "needs-decision" && run.reason?.startsWith("review ")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

const rpcSeverity = (severity: Severity) => severity ?? ("none" as const);
const rpcChange = (change: CommentChange) => ("severity" in change ? { severity: rpcSeverity(change.severity) } : change);

/**
 * The review screen: everything needed to judge a PR without leaving Paseo. A header with the PR's
 * shape and the verdict; tabs for the reviewer's summary and reasoning, its walkthrough, every file's
 * diff with the comments in place, the author's description and the comment list; a bottom bar that
 * picks the verdict and posts after a confirm, then moves on to the next review.
 */
export function ReviewScreen({ theme, layout, navigation, params }: PluginScreenProps) {
  const { view, refresh } = useInbox(10_000);
  const [runId, setRunId] = useState(params.runId ?? "");
  useEffect(() => setRunId(params.runId ?? ""), [params.runId]);
  const run = view?.runs.find((candidate) => candidate.id === runId) ?? null;
  const pr = run ? view?.items[run.itemKey]?.pr : undefined;

  const fetchDraft = useRpc(getReview);
  const fetchDetails = useRpc(getPrDetails);
  const changeComment = useRpc(updateReviewComment);
  const addComment = useRpc(addReviewComment);
  const deleteComment = useRpc(deleteReviewComment);
  const setVerdict = useRpc(setReviewVerdict);
  const post = useRpc(postReview);
  const discuss = useRpc(discussReview);
  const redraft = useRpc(runNow);
  const dismiss = useRpc(skipRun);

  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [details, setDetails] = useState<PrDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);

  // The prev/next set is fixed when the screen opens, so posting or dismissing doesn't reshuffle it.
  const snapshot = useRef<string[] | null>(null);
  if (!snapshot.current && view) snapshot.current = reviewQueue(view.runs).map((candidate) => candidate.id);
  const queue = snapshot.current ?? [];
  const position = queue.indexOf(runId);

  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught));

  useEffect(() => {
    if (!runId) return;
    setDraft(null);
    setError(null);
    setNotice(null);
    setTab("summary");
    setOpenFiles(new Set());
    setConfirming(false);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }, [runId]);

  // Re-read the draft whenever the run changes (the reviewer revised it), not just on open.
  const runStamp = run?.updatedAt;
  useEffect(() => {
    if (!runId) return;
    let live = true;
    void fetchDraft({ runId })
      .then((value) => live && setDraft(value))
      .catch((caught) => live && fail(caught));
    return () => {
      live = false;
    };
  }, [fetchDraft, runId, runStamp]);

  // Fetched at GitHub's live head when the screen opens, so "new commits" is never a poll behind.
  const itemKey = run?.itemKey;
  useEffect(() => {
    if (!itemKey) return;
    let live = true;
    setDetails(null);
    void fetchDetails({ itemKey })
      .then((value) => live && setDetails(value))
      .catch((caught) => live && fail(caught));
    return () => {
      live = false;
    };
  }, [fetchDetails, itemKey]);

  const files = details?.files ?? [];
  const chapters = useMemo(() => (draft ? walkthrough(draft, files) : []), [draft, files]);
  const commentsByFile = useMemo(() => {
    const map = new Map<string, ReviewDraft["comments"]>();
    for (const comment of draft?.comments ?? []) map.set(comment.path, [...(map.get(comment.path) ?? []), comment]);
    return map;
  }, [draft]);

  const headSha = details?.headSha ?? pr?.headSha;
  const stale = Boolean(draft && headSha && headSha !== draft.version);
  const editable = Boolean(draft && !draft.postedUrl && run?.state === "needs-decision" && !stale);

  const goTo = (offset: number) => {
    const next = queue[position + offset];
    if (next) setRunId(next);
  };
  const next = queue.slice(position + 1).find((id) => view?.runs.some((candidate) => candidate.id === id && candidate.state === "needs-decision"));

  const ask = useCallback(
    async (question: string, about: string) => {
      try {
        const text = question || `Is this right? If the draft should change, change it with ${REVISE_TOOL}.`;
        await discuss({ runId, message: `About ${about}:\n\n${text}` });
        if (run?.agentId && navigation) navigation.openAgent({ agentId: run.agentId });
        else setNotice("Sent to the reviewer.");
      } catch (caught) {
        fail(caught);
      }
    },
    [discuss, runId, run?.agentId, navigation],
  );

  const actions: DiffActions = {
    editable,
    onChange: async (commentId, change) => {
      try {
        setDraft(await changeComment({ runId, commentId, ...rpcChange(change) }));
      } catch (caught) {
        fail(caught);
      }
    },
    onDelete: async (commentId) => {
      try {
        setDraft(await deleteComment({ runId, commentId }));
      } catch (caught) {
        fail(caught);
      }
    },
    onAdd: async (comment) => {
      try {
        setDraft(await addComment({ runId, ...comment, severity: rpcSeverity(comment.severity) }));
      } catch (caught) {
        fail(caught);
      }
    },
    onAsk: (question, about) => void ask(question, about),
  };

  const act = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };
  const submit = () =>
    act("post", async () => {
      const result = await post({ runId });
      setDraft((current) => (current ? { ...current, postedUrl: result.url, postedVerdict: effectiveVerdict(current) } : current));
      setNotice(`Posted: ${result.inline} inline${result.folded ? `, ${result.folded} in the review body` : ""}.`);
      await refresh();
    });
  const done = () =>
    act("done", async () => {
      if (run) await dismiss({ itemKey: run.itemKey, rule: run.rule });
      await refresh();
      if (next) setRunId(next);
      else setNotice("Dismissed. Later pushes won't draft this PR again.");
    });
  const rerun = () =>
    act("redraft", async () => {
      if (run) await redraft({ itemKey: run.itemKey, rule: run.rule });
      await refresh();
      setNotice("Re-drafting at the new head. It appears in the Inbox when it's ready.");
    });

  const toggleFile = (path: string, force?: boolean) =>
    setOpenFiles((current) => {
      const nextOpen = new Set(current);
      if (force ?? !nextOpen.has(path)) nextOpen.add(path);
      else nextOpen.delete(path);
      return nextOpen;
    });

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const pad = layout.compact ? 14 : 24;
  const maxWidth = 980;
  const small = { paddingVertical: 4, paddingHorizontal: 10 };

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
  const folded = live.filter((comment) => details && placement(comment, files) !== "inline").length;
  const verdict = draft ? effectiveVerdict(draft) : null;
  const mismatch = draft ? verdictMismatch(draft) : null;
  const tabs: { id: Tab; label: string }[] = [
    { id: "summary", label: "Summary" },
    ...(chapters.length ? [{ id: "walkthrough" as const, label: `Walkthrough ${chapters.length}` }] : []),
    { id: "files", label: `Files ${details ? files.length : pr.files.length}` },
    { id: "description", label: "Description" },
    { id: "comments", label: `Comments ${live.length}` },
  ];

  const fileDiff = (path: string) => {
    const file = files.find((candidate) => candidate.path === path);
    return file ? (
      <FileDiff key={path} file={file} comments={commentsByFile.get(path) ?? []} theme={theme} compact={layout.compact} open={openFiles.has(path)} onToggle={() => toggleFile(path)} actions={actions} />
    ) : (
      <Text key={path} style={muted}>
        {path}
      </Text>
    );
  };

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
                <Chip theme={theme} label="‹" accessibilityLabel="Previous review" disabled={position <= 0} onPress={() => goTo(-1)} />
                <Chip theme={theme} label="›" accessibilityLabel="Next review" disabled={position < 0 || position >= queue.length - 1} onPress={() => goTo(1)} />
              </>
            ) : null}
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: layout.compact ? 18 : 22, fontWeight: "700", lineHeight: layout.compact ? 24 : 28 }}>{pr.title}</Text>
          <Text style={muted}>
            {details?.author || pr.author || "?"}
            {details ? `  ·  ${details.headRef} → ${details.baseRef}` : ""}
            {"  ·  "}
            <Text style={{ fontFamily: MONO }}>{(headSha ?? "").slice(0, 7)}</Text>
            {"  ·  "}
            <Text style={{ color: theme.colors.statusSuccess }}>+{details?.additions ?? pr.additions}</Text> <Text style={{ color: theme.colors.statusDanger }}>−{details?.deletions ?? pr.deletions}</Text>
            {`  ·  ${details?.changedFiles ?? pr.files.length} files`}
            {pr.checks !== "none" ? "  ·  checks " : ""}
            {pr.checks !== "none" ? <Text style={{ color: pr.checks === "passing" ? theme.colors.statusSuccess : pr.checks === "failing" ? theme.colors.statusDanger : theme.colors.statusWarning }}>{pr.checks}</Text> : null}
            {pr.isDraft ? "  ·  draft PR" : ""}
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {draft && verdict ? (
              <Pill theme={theme} color={verdictColor(theme, verdict)}>
                {verdict} · {draft.confidence}%{draft.verdictOverride ? " (yours)" : ""}
              </Pill>
            ) : null}
            {stale ? <Pill theme={theme} color={theme.colors.statusWarning}>new commits since this draft</Pill> : null}
            {draft?.postedUrl ? <Pill theme={theme} color={theme.colors.statusSuccess}>posted</Pill> : null}
            <View style={{ flex: 1 }} />
            <Chip theme={theme} label="GitHub ↗" onPress={() => void Linking.openURL(pr.url)} />
            {run.agentId && navigation ? <Chip theme={theme} label="Reviewer chat" onPress={() => navigation.openAgent({ agentId: run.agentId! })} /> : null}
          </View>
          {stale && run.state !== "running" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text style={{ ...muted, flex: 1 }}>The PR moved on since this was drafted ({draft?.version.slice(0, 7)} → {headSha?.slice(0, 7)}), so the comments may sit on the wrong lines.</Text>
              <Chip theme={theme} active label={busy === "redraft" ? "Re-drafting…" : "Re-draft at the new head"} disabled={Boolean(busy)} onPress={() => void rerun()} />
            </View>
          ) : null}
          {notice ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>{notice}</Text> : null}
          {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
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
          {!draft && tab !== "description" && tab !== "files" ? <Text style={muted}>No review draft for this run yet.</Text> : null}

          {tab === "summary" && draft ? (
            <>
              <Markdown text={draft.summary} theme={theme} />
              {draft.reasoning ? (
                <View style={{ gap: 8, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 12 }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.5 }}>WHY {draft.verdict.toUpperCase()}</Text>
                  <Markdown text={draft.reasoning} theme={theme} size={14} />
                </View>
              ) : null}
              {editable ? (
                <Chip theme={theme} label="Ask about the summary" style={{ ...small, alignSelf: "flex-start" }} textStyle={{ fontSize: 12 }} onPress={() => void ask("", "your summary and verdict")} />
              ) : null}
            </>
          ) : null}

          {tab === "walkthrough" && draft
            ? chapters.map((chapter, index) => (
                <View key={chapter.title + index} style={{ gap: 8, paddingBottom: 8 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700" }}>
                    {chapter.other ? chapter.title : `${index + 1}. ${chapter.title}`}
                  </Text>
                  {chapter.body ? <Markdown text={chapter.body} theme={theme} size={14} /> : null}
                  {chapter.files.map(fileDiff)}
                </View>
              ))
            : null}

          {tab === "files" ? (
            details ? (
              <>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Chip theme={theme} label="Expand all" onPress={() => setOpenFiles(new Set(files.map((file) => file.path)))} />
                  <Chip theme={theme} label="Collapse all" onPress={() => setOpenFiles(new Set())} />
                  {live.length ? <Chip theme={theme} label="Only commented" onPress={() => setOpenFiles(new Set(live.map((comment) => comment.path)))} /> : null}
                </View>
                {files.map((file) => fileDiff(file.path))}
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
                <CommentCard
                  key={comment.id}
                  comment={comment}
                  theme={theme}
                  editable={editable}
                  where={details ? placement(comment, files) : "inline"}
                  onChange={(change) => actions.onChange(comment.id, change)}
                  onDelete={() => actions.onDelete(comment.id)}
                  onDiscuss={() => void ask("", `your comment on ${comment.path}${comment.line ? `:${comment.line}` : ""} (${comment.id}): "${comment.body}"`)}
                  onOpenFile={() => {
                    toggleFile(comment.path, true);
                    setTab("files");
                  }}
                />
              ))
            ) : (
              <Text style={muted}>No inline comments. Open a file and tap a line to add one.</Text>
            )
          ) : null}
        </View>
      </ScrollView>

      {/* Decision bar */}
      {draft && !draft.postedUrl && verdict ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, backgroundColor: theme.colors.surface1, paddingHorizontal: pad, paddingVertical: 10 }}>
          <View style={{ gap: 8, width: "100%", maxWidth, alignSelf: "center" }}>
            {mismatch && editable ? (
              <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>
                {mismatch}.{" "}
                <Text style={{ color: theme.colors.accent }} onPress={() => void ask("The verdict disagrees with the findings still standing. Fix whichever is wrong.", "the verdict")}>
                  Ask the reviewer
                </Text>
              </Text>
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {VerdictSchema.options.map((option) => (
                <Chip
                  key={option}
                  theme={theme}
                  label={option}
                  active={verdict === option}
                  disabled={!editable}
                  style={small}
                  textStyle={{ fontSize: 12 }}
                  onPress={() => void act("verdict", async () => setDraft(await setVerdict({ runId, verdict: option })))}
                />
              ))}
              <View style={{ flex: 1 }} />
              <Chip theme={theme} label={busy === "done" ? "…" : next ? "Dismiss, next" : "Dismiss"} disabled={Boolean(busy)} style={small} textStyle={{ fontSize: 12 }} onPress={() => void done()} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ ...muted, flex: 1 }} numberOfLines={2}>
                {stale ? "Re-draft before posting." : `${live.length} comment${live.length === 1 ? "" : "s"}${folded ? ` (${folded} in the body)` : ""}${draft.comments.length > live.length ? ` · ${draft.comments.length - live.length} dropped` : ""}`}
              </Text>
              {confirming ? <Chip theme={theme} label="Cancel" onPress={() => setConfirming(false)} /> : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={confirming ? "Confirm posting the review to GitHub" : "Post review"}
                disabled={!editable || Boolean(busy)}
                onPress={() => (confirming ? void submit() : setConfirming(true))}
                style={{ backgroundColor: confirming ? verdictColor(theme, verdict) : theme.colors.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, opacity: !editable || busy ? 0.5 : 1 }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", fontSize: 14 }}>{busy === "post" ? "Posting…" : confirming ? `Post as ${verdict}` : "Post review"}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : draft?.postedUrl ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, padding: 12, flexDirection: "row", gap: 10, justifyContent: "center", backgroundColor: theme.colors.surface1 }}>
          <Chip theme={theme} label={`Posted as ${draft.postedVerdict ?? draft.verdict} ↗`} onPress={() => void Linking.openURL(draft.postedUrl!)} />
          {next ? <Chip theme={theme} active label="Next review ›" onPress={() => setRunId(next)} /> : null}
        </View>
      ) : null}
    </View>
  );
}
