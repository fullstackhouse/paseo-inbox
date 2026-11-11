import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { addPr, DISMISSED, parsePrRef, restoreRun, reviewRunFor, runNow, skipRun, type Run } from "../shared/inbox";
import {
  addReviewComment,
  deleteReviewComment,
  discussReview,
  effectiveVerdict,
  getPrDetails,
  getReview,
  handoffReview,
  isViewed,
  placement,
  postReview,
  previewReview,
  prPeople,
  setReviewBody,
  setFileViewed,
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
import { reanchorReview, reviewSince, type Since } from "../shared/rereview";
import { AskBox, CommentCard } from "./CommentCard";
import { HandoffPanel, PreviewPane } from "./Decide";
import { FileDiff, type DiffActions } from "./FileDiff";
import { Markdown } from "./Markdown";
import { useOpenUrl } from "./openUrl";
import { ago, Chip, MONO, Pill, verdictColor } from "./ui";
import { useInbox } from "./useInbox";

export const REVIEW_SCREEN = "review";

type Tab = "summary" | "walkthrough" | "since" | "files" | "description" | "comments" | "preview";

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
/** "drafted 3h ago", "drafted just now". */
function ageLabel(what: string, iso: string): string {
  const age = ago(iso);
  return age === "now" ? `${what} just now` : `${what} ${age} ago`;
}

export function ReviewScreen({ theme, layout, navigation, params }: PluginScreenProps) {
  const { view, refresh } = useInbox(10_000);
  const [runId, setRunId] = useState(params.runId ?? "");
  useEffect(() => setRunId(params.runId ?? ""), [params.runId]);
  // Opened by PR (`{ pr }`, e.g. from paseo-prs): show that PR's newest review once the inbox loads.
  const prRef = params.runId ? "" : (params.pr ?? "");
  const byPr = prRef && view ? reviewRunFor(view.runs, view, prRef) : null;
  useEffect(() => {
    if (byPr && !runId) setRunId(byPr.id);
  }, [byPr, runId]);
  const run = view?.runs.find((candidate) => candidate.id === runId) ?? null;
  const pr = run ? view?.items[run.itemKey]?.pr : undefined;

  const fetchDraft = useRpc(getReview);
  const restoreDraft = useRpc(restoreRun);
  const fetchDetails = useRpc(getPrDetails);
  const changeComment = useRpc(updateReviewComment);
  const addComment = useRpc(addReviewComment);
  const deleteComment = useRpc(deleteReviewComment);
  const setVerdict = useRpc(setReviewVerdict);
  const post = useRpc(postReview);
  const discuss = useRpc(discussReview);
  const redraft = useRpc(runNow);
  const startReview = useRpc(addPr);
  const dismiss = useRpc(skipRun);
  const markViewed = useRpc(setFileViewed);
  const preview = useRpc(previewReview);
  const saveBody = useRpc(setReviewBody);
  const people = useRpc(prPeople);
  const handoff = useRpc(handoffReview);
  const reanchor = useRpc(reanchorReview);
  const fetchSince = useRpc(reviewSince);
  const [since, setSince] = useState<Since | null>(null);
  const [sinceOpen, setSinceOpen] = useState<Set<string>>(new Set());
  const [handingOff, setHandingOff] = useState(false);
  const [askingSummary, setAskingSummary] = useState(false);
  const openUrl = useOpenUrl();

  const [draft, setDraft] = useState<ReviewDraft | null>(null);
  const [details, setDetails] = useState<PrDetails | null>(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("summary");
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [closedChapters, setClosedChapters] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const scroll = useRef<ScrollView>(null);
  const carried = useRef<string | null>(null);
  // Jump-to-file: where the content and each file card sit, and which file to scroll to once laid out.
  const contentY = useRef(0);
  const fileY = useRef(new Map<string, number>());
  const [scrollTo, setScrollTo] = useState<string | null>(null);

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
    setNotice(carried.current);
    carried.current = null;
    setTab("summary");
    setAskingSummary(false);
    setOpenFiles(new Set());
    setClosedChapters(new Set());
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
      .then((value) => {
        if (!live) return;
        setDetails(value);
        setDetailsFor(itemKey);
      })
      .catch((caught) => live && fail(caught));
    return () => {
      live = false;
    };
  }, [fetchDetails, itemKey]);

  // "Changes since my last review": asked once the live head is known, again when the draft moves.
  const liveHead = details && detailsFor === itemKey ? details.headSha : null;
  const draftVersion = draft?.version;
  useEffect(() => {
    if (!runId || !liveHead) return;
    let live = true;
    setSince(null);
    void fetchSince({ runId })
      .then((value) => {
        if (!live) return;
        setSince(value);
        setSinceOpen(new Set(value.kind === "changes" ? value.files.map((file) => file.path) : []));
      })
      .catch(() => live && setSince(null));
    return () => {
      live = false;
    };
  }, [fetchSince, runId, liveHead, draftVersion]);

  const files = details?.files ?? [];
  // Like Cerber and GitHub, diffs (with their comments) start open; big uncommented files fold
  // themselves, and files already marked viewed start closed.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!details || detailsFor !== itemKey || opened.current === runId) return;
    opened.current = runId;
    setOpenFiles(new Set(details.files.filter((file) => !isViewed(draft, file)).map((file) => file.path)));
    if (draft) setClosedChapters(new Set(chapterIndexes(walkthrough(draft, details.files), (path) => chapterViewed(draft, details.files, path))));
  }, [details, detailsFor, itemKey, draft, runId]);
  const chapters = useMemo(() => (draft ? walkthrough(draft, files) : []), [draft, files]);
  const commentsByFile = useMemo(() => {
    const map = new Map<string, ReviewDraft["comments"]>();
    for (const comment of draft?.comments ?? []) map.set(comment.path, [...(map.get(comment.path) ?? []), comment]);
    return map;
  }, [draft]);

  const headSha = details?.headSha ?? pr?.headSha;
  const stale = Boolean(draft && headSha && headSha !== draft.version);
  // A draft the PR moved past stays postable: it posts on its own commit, where its comments were written.
  const editable = Boolean(draft && !draft.postedUrl && (run?.state === "needs-decision" || run?.state === "stale"));

  const goTo = (offset: number) => {
    const next = queue[position + offset];
    if (next) setRunId(next);
  };
  const next = queue.slice(position + 1).find((id) => view?.runs.some((candidate) => candidate.id === id && candidate.state === "needs-decision"));

  /** True once the question reached the reviewer; on failure the error shows and the asker keeps its text. */
  const ask = useCallback(
    async (question: string, about: string): Promise<boolean> => {
      try {
        await discuss({ runId, message: `About ${about}:\n\n${question}` });
        if (run?.agentId && navigation) navigation.openAgent({ agentId: run.agentId });
        else setNotice("Sent to the reviewer.");
        return true;
      } catch (caught) {
        fail(caught);
        return false;
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
    onAsk: ask,
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
  const carry = () =>
    act("reanchor", async () => {
      const result = await reanchor({ runId });
      await refresh();
      // Shown once the screen has reset for the new run id.
      carried.current = `Comments moved to the new head: ${result.moved} moved, ${result.unchanged} unchanged${result.drifted ? `, ${result.drifted} drifted (their line changed; they go in the review body)` : ""}.`;
      setRunId(result.runId);
    });
  const dismissed = Boolean(draft && !draft.postedUrl && run?.state === "done" && run.reason === DISMISSED);
  const restore = () =>
    act("restore", async () => {
      if (run) await restoreDraft({ runId: run.id });
      await refresh();
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

  const toggleChapter = (index: number) =>
    setClosedChapters((current) => {
      const nextClosed = new Set(current);
      if (nextClosed.has(index)) nextClosed.delete(index);
      else nextClosed.add(index);
      return nextClosed;
    });

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const pad = layout.compact ? 14 : 24;
  const maxWidth = 980;
  const small = { paddingVertical: 4, paddingHorizontal: 10 };

  if (!runId && prRef && (!view || byPr)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: theme.colors.surface0 }}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    );
  }
  if (!runId && prRef) {
    const parsed = parsePrRef(prRef);
    const prLabel = parsed ? `${parsed.repo}#${parsed.number}` : prRef;
    const start = async () => {
      setBusy("start");
      setError(null);
      try {
        const started = await startReview({ ref: prRef });
        await refresh();
        setRunId(started.runId);
      } catch (caught) {
        fail(caught);
      } finally {
        setBusy(null);
      }
    };
    return (
      <View style={{ flex: 1, padding: pad, gap: 12, alignItems: "flex-start", backgroundColor: theme.colors.surface0 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }}>No review of {prLabel} yet</Text>
        <Text style={muted}>Start one and a reviewer drafts it here. You read and post it from this screen.</Text>
        <Chip theme={theme} active label={busy === "start" ? "Starting…" : "Start review"} disabled={busy === "start"} onPress={() => void start()} />
        {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
      </View>
    );
  }
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

  // Opened from a running row: the screen fills in when the reviewer saves its draft (the run's updatedAt moves, so the draft is re-read).
  const drafting = !draft && (run.state === "running" || run.state === "queued");
  const live = draft?.comments.filter((comment) => comment.status !== "dropped") ?? [];
  const folded = live.filter((comment) => details && placement(comment, files) !== "inline").length;
  const verdict = draft ? effectiveVerdict(draft) : null;
  const mismatch = draft ? verdictMismatch(draft) : null;
  const threadsFor = (path: string) => details?.threads.filter((thread) => thread.path === path) ?? [];
  const tabs: { id: Tab; label: string }[] = [
    { id: "summary", label: "Summary" },
    ...(chapters.length ? [{ id: "walkthrough" as const, label: `Walkthrough ${chapters.length}` }] : []),
    ...(since && since.kind !== "none" ? [{ id: "since" as const, label: `Since ${since.base.slice(0, 7)}${since.kind === "changes" ? ` · ${since.files.length}` : ""}` }] : []),
    { id: "files", label: `Files ${details ? files.length : pr.files.length}` },
    { id: "description", label: "Description" },
    { id: "comments", label: `Comments ${live.length}` },
    ...(draft && !draft.postedUrl ? [{ id: "preview" as const, label: draft.bodyOverride !== undefined ? "Preview (edited)" : "Preview" }] : []),
  ];

  const viewedCount = files.filter((file) => isViewed(draft, file)).length;
  const fileDiff = (path: string, track = false) => {
    const file = files.find((candidate) => candidate.path === path);
    return file ? (
      <View
        key={path}
        onLayout={
          track
            ? (event) => {
                fileY.current.set(path, event.nativeEvent.layout.y);
                if (scrollTo === path) {
                  scroll.current?.scrollTo({ y: Math.max(0, contentY.current + event.nativeEvent.layout.y - 64), animated: true });
                  setScrollTo(null);
                }
              }
            : undefined
        }
      >
        <FileDiff
          file={file}
          comments={commentsByFile.get(path) ?? []}
          theme={theme}
          compact={layout.compact}
          open={openFiles.has(path)}
          onToggle={() => toggleFile(path)}
          actions={actions}
          viewed={isViewed(draft, file)}
          threads={threadsFor(path)}
          onViewed={
            draft && !draft.postedUrl
              ? (value) =>
                  void markViewed({ runId, path, patch: file.patch, viewed: value })
                    .then((next) => {
                      setDraft(next);
                      // Ticking a file folds it away, like GitHub's "Viewed", and its chapter once every file in it is viewed.
                      if (!value) return;
                      toggleFile(path, false);
                      const finished = chapterIndexes(
                        walkthrough(next, files).map((chapter) => (chapter.files.includes(path) ? chapter : { files: [] })),
                        (candidate) => chapterViewed(next, files, candidate),
                      );
                      if (finished.length) setClosedChapters((current) => new Set([...current, ...finished]));
                    })
                    .catch(fail)
              : undefined
          }
        />
      </View>
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
            {draft ? <Pill theme={theme} color={theme.colors.foregroundMuted}>{ageLabel("drafted", draft.createdAt)}{draft.reanchored ? ` · ${ageLabel("moved", draft.reanchored.at)}` : ""}</Pill> : null}
            {drafting ? <Pill theme={theme} color={theme.colors.foregroundMuted}>{run.state === "queued" ? "queued" : "drafting…"}</Pill> : null}
            {stale ? <Pill theme={theme} color={theme.colors.statusWarning}>new commits since this draft</Pill> : null}
            {draft?.reviewedVersion && draft.reviewedVersion !== draft.version ? <Pill theme={theme} color={theme.colors.foregroundMuted}>summary written for {draft.reviewedVersion.slice(0, 7)}</Pill> : null}
            {draft?.postedUrl ? <Pill theme={theme} color={theme.colors.statusSuccess}>posted</Pill> : null}
            {run.trusted === false ? <Pill theme={theme} color={theme.colors.statusWarning}>read-only run: author not trusted</Pill> : null}
            {details?.threads.length ? <Pill theme={theme} color={theme.colors.foregroundMuted}>{details.threads.length} comments from others</Pill> : null}
            <View style={{ flex: 1 }} />
            <Chip theme={theme} label="GitHub ↗" onPress={() => openUrl(pr.url)} />
            {run.agentId && navigation ? <Chip theme={theme} label="Reviewer chat" onPress={() => navigation.openAgent({ agentId: run.agentId! })} /> : null}
          </View>
          {stale && run.state !== "running" ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text style={{ ...muted, flex: 1, minWidth: 220 }}>
                The PR moved on since this was drafted ({draft?.version.slice(0, 7)} → {headSha?.slice(0, 7)}). Move the comments to the new head to keep your decisions (no AI run; the summary stays as written), re-draft from scratch, or post it as is on {draft?.version.slice(0, 7)}.
              </Text>
              {draft && !draft.postedUrl ? <Chip theme={theme} active label={busy === "reanchor" ? "Moving…" : "Move comments to the new head"} disabled={Boolean(busy)} onPress={() => void carry()} /> : null}
              <Chip theme={theme} label={busy === "redraft" ? "Re-drafting…" : "Re-draft at the new head"} disabled={Boolean(busy)} onPress={() => void rerun()} />
            </View>
          ) : null}
          {dismissed ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Text style={{ ...muted, flex: 1, minWidth: 220 }}>You dismissed this review ({ago(run.updatedAt)} ago). Restore it to edit and post it.</Text>
              <Chip theme={theme} active label={busy === "restore" ? "Restoring…" : "Restore"} disabled={Boolean(busy)} onPress={() => void restore()} />
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
        <View onLayout={(event) => (contentY.current = event.nativeEvent.layout.y)} style={{ paddingHorizontal: pad, paddingTop: 14, gap: 12, width: "100%", maxWidth, alignSelf: "center" }}>
          {!draft && tab !== "description" && tab !== "files" ? (
            drafting ? (
              <View style={{ gap: 10, alignItems: "flex-start", backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 14 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <ActivityIndicator color={theme.colors.foregroundMuted} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{run.state === "queued" ? "Waiting for a free slot" : "The reviewer is drafting this review"}</Text>
                </View>
                <Text style={muted}>
                  The summary, verdict and comments appear here when the draft is saved{run.state === "running" ? ` (started ${ago(run.updatedAt)} ago)` : ""}. Read the Files and Description in the meantime.
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Chip theme={theme} label="Files" style={small} textStyle={{ fontSize: 12 }} onPress={() => setTab("files")} />
                  {run.agentId && navigation ? <Chip theme={theme} label="Watch the reviewer" style={small} textStyle={{ fontSize: 12 }} onPress={() => navigation.openAgent({ agentId: run.agentId! })} /> : null}
                </View>
              </View>
            ) : (
              <Text style={muted}>No review draft for this run yet{run.reason ? ` (${run.reason})` : ""}.</Text>
            )
          ) : null}

          {tab === "summary" && draft ? (
            <>
              {draft.reviewedVersion && draft.reviewedVersion !== draft.version ? (
                <Text style={muted}>
                  Written for {draft.reviewedVersion.slice(0, 7)}. The comments were moved to {draft.version.slice(0, 7)} without a new review; see what changed in Since {draft.reviewedVersion.slice(0, 7)}.
                </Text>
              ) : null}
              <Markdown text={draft.summary} theme={theme} />
              {draft.reasoning ? (
                <View style={{ gap: 8, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 12 }}>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.5 }}>WHY {draft.verdict.toUpperCase()}</Text>
                  <Markdown text={draft.reasoning} theme={theme} size={14} />
                </View>
              ) : null}
              {editable && askingSummary ? (
                <AskBox
                  theme={theme}
                  onCancel={() => setAskingSummary(false)}
                  onAsk={async (question) => {
                    if (await ask(question, "your summary and verdict")) setAskingSummary(false);
                  }}
                />
              ) : editable ? (
                <Chip theme={theme} label="Ask about the summary" style={{ ...small, alignSelf: "flex-start" }} textStyle={{ fontSize: 12 }} onPress={() => setAskingSummary(true)} />
              ) : null}
            </>
          ) : null}

          {tab === "walkthrough" && draft && !details ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : null}
          {tab === "walkthrough" && draft && details
            ? chapters.map((chapter, index) => {
                const open = !closedChapters.has(index);
                const title = chapter.other ? chapter.title : `${index + 1}. ${chapter.title}`;
                return (
                  <View key={chapter.title + index} style={{ gap: 8, paddingBottom: 8 }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      accessibilityLabel={`${open ? "Collapse" : "Expand"} ${title}`}
                      onPress={() => toggleChapter(index)}
                      style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}
                    >
                      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 16, fontWeight: "700" }}>
                        {title}
                        <Text style={{ ...muted, fontWeight: "400" }}>
                          {"  "}
                          {chapter.files.filter((path) => chapterViewed(draft, files, path)).length}/{chapter.files.length} viewed
                        </Text>
                      </Text>
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, paddingTop: 4 }}>{open ? "▾" : "▸"}</Text>
                    </Pressable>
                    {open && chapter.body ? <Markdown text={chapter.body} theme={theme} size={14} /> : null}
                    {open ? chapter.files.map((path) => fileDiff(path)) : null}
                  </View>
                );
              })
            : null}

          {tab === "since" && since && since.kind !== "none" ? (
            <SinceView
              since={since}
              theme={theme}
              compact={layout.compact}
              muted={muted}
              open={sinceOpen}
              onToggle={(path) =>
                setSinceOpen((current) => {
                  const nextOpen = new Set(current);
                  if (nextOpen.has(path)) nextOpen.delete(path);
                  else nextOpen.add(path);
                  return nextOpen;
                })
              }
              // Only a draft at the head has comments on these lines; the old side here is the old commit, not the base.
              comments={(path) => (stale ? [] : (commentsByFile.get(path) ?? []).filter((comment) => comment.side === "RIGHT" && !comment.drifted))}
              actions={{ ...actions, editable: false }}
              onFiles={() => setTab("files")}
            />
          ) : null}

          {tab === "files" ? (
            details ? (
              <>
                <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                  <Chip theme={theme} label="Expand all" onPress={() => setOpenFiles(new Set(files.map((file) => file.path)))} />
                  <Chip theme={theme} label="Collapse all" onPress={() => setOpenFiles(new Set())} />
                  {live.length ? <Chip theme={theme} label="Only commented" onPress={() => setOpenFiles(new Set(live.map((comment) => comment.path)))} /> : null}
                  <Chip theme={theme} label="Not viewed" onPress={() => setOpenFiles(new Set(files.filter((file) => !isViewed(draft, file)).map((file) => file.path)))} />
                  <Text style={{ ...muted, alignSelf: "center" }}>
                    {viewedCount}/{files.length} viewed
                  </Text>
                </View>
                {files.map((file) => fileDiff(file.path, true))}
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

          {tab === "preview" && draft ? (
            <PreviewPane
              theme={theme}
              runId={runId}
              stamp={JSON.stringify(draft)}
              editable={editable}
              onDraft={setDraft}
              load={() => preview({ runId })}
              saveBody={(body) => saveBody({ runId, body })}
            />
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
                  onDiscuss={(question) => ask(question, `your comment on ${comment.path}${comment.line ? `:${comment.line}` : ""} (${comment.id}): "${comment.body}"`)}
                  onOpenFile={() => {
                    toggleFile(comment.path, true);
                    setTab("files");
                    setScrollTo(comment.path);
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
            {handingOff && run ? (
              <HandoffPanel
                theme={theme}
                hasDraft={Boolean(draft)}
                loadPeople={() => people({ itemKey: run.itemKey })}
                onCancel={() => setHandingOff(false)}
                onHandoff={(input) =>
                  act("handoff", async () => {
                    const result = await handoff({ runId, ...input });
                    setHandingOff(false);
                    setNotice(`Handed off to ${input.to.startsWith("@") ? input.to : `@${input.to}`}.`);
                    setDraft((current) => (current ? { ...current, postedUrl: result.url } : current));
                    await refresh();
                  })
                }
              />
            ) : null}
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
                  onPress={() =>
                    void act("verdict", async () => {
                      setDraft(await setVerdict({ runId, verdict: option }));
                      // The chat pill's Post item names the verdict.
                      await refresh();
                    })
                  }
                />
              ))}
              <View style={{ flex: 1 }} />
              <Chip theme={theme} label="Hand off" active={handingOff} disabled={Boolean(busy) || !run.agentId} style={small} textStyle={{ fontSize: 12 }} onPress={() => setHandingOff(!handingOff)} />
              <Chip theme={theme} label={busy === "done" ? "…" : next ? "Dismiss, next" : "Dismiss"} disabled={Boolean(busy)} style={small} textStyle={{ fontSize: 12 }} onPress={() => void done()} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ ...muted, flex: 1 }} numberOfLines={2}>
                {stale ? `Posts on ${draft.version.slice(0, 7)}, where it was drafted; GitHub marks comments outdated where the code changed since. ` : ""}{`${live.length} comment${live.length === 1 ? "" : "s"}${folded ? ` (${folded} in the body)` : ""}${draft.comments.length > live.length ? ` · ${draft.comments.length - live.length} dropped` : ""}`}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Post the review to GitHub as ${verdict}`}
                disabled={!editable || Boolean(busy)}
                onPress={() => void submit()}
                style={{ backgroundColor: verdictColor(theme, verdict), paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, opacity: !editable || busy ? 0.5 : 1 }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", fontSize: 14 }}>{busy === "post" ? "Posting…" : `Post as ${verdict}`}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : draft?.postedUrl ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, padding: 12, flexDirection: "row", gap: 10, justifyContent: "center", backgroundColor: theme.colors.surface1 }}>
          <Chip theme={theme} label={`Posted as ${draft.postedVerdict ?? draft.verdict} ↗`} onPress={() => openUrl(draft.postedUrl!)} />
          {next ? <Chip theme={theme} active label="Next review ›" onPress={() => setRunId(next)} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const SINCE_FROM = { draft: "this draft's commit", reviewed: "the commit the summary was written for", posted: "your last review" } as const;

/** What changed since the commit the human last reviewed: its commits, then each changed file's diff. */
function SinceView({
  since,
  theme,
  compact,
  muted,
  open,
  onToggle,
  comments,
  actions,
  onFiles,
}: {
  since: Exclude<Since, { kind: "none" }>;
  theme: PluginScreenProps["theme"];
  compact: boolean;
  muted: { color: string; fontSize: number };
  open: Set<string>;
  onToggle: (path: string) => void;
  comments: (path: string) => ReviewDraft["comments"];
  actions: DiffActions;
  onFiles: () => void;
}) {
  const what = `${SINCE_FROM[since.from]}${since.at ? ` (${ago(since.at)} ago)` : ""}, ${since.base.slice(0, 7)}`;
  if (since.kind === "same") return <Text style={muted}>No new commits since {what}.</Text>;
  if (since.kind === "rewritten")
    return (
      <View style={{ gap: 8, alignItems: "flex-start" }}>
        <Text style={{ color: theme.colors.statusWarning, fontSize: 14 }}>
          {since.why === "unreachable" ? `GitHub no longer has ${since.base.slice(0, 7)}` : `The branch no longer contains ${since.base.slice(0, 7)}`}: it was force-pushed or rebased since {SINCE_FROM[since.from]}, so there's no clean diff of what changed. Read the full diff instead.
        </Text>
        <Chip theme={theme} label="Open Files" onPress={onFiles} />
      </View>
    );
  return (
    <>
      <Text style={muted}>
        Since {what} → {since.head.slice(0, 7)}: {since.commits.length} commit{since.commits.length === 1 ? "" : "s"}, {since.files.length} file{since.files.length === 1 ? "" : "s"}
        {since.hidden ? `, plus ${since.hidden} the PR doesn't change (merged from the base branch), left out` : ""}.
      </Text>
      {since.commits.length ? (
        <View style={{ gap: 4, backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 10 }}>
          {since.commits.map((commit) => (
            <Text key={commit.sha} style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={1}>
              <Text style={{ fontFamily: MONO, color: theme.colors.foregroundMuted }}>{commit.sha.slice(0, 7)}</Text> {commit.message.split("\n")[0]}
            </Text>
          ))}
        </View>
      ) : null}
      {since.files.length ? (
        since.files.map((file) => <FileDiff key={file.path} file={file} comments={comments(file.path)} theme={theme} compact={compact} open={open.has(file.path)} onToggle={() => onToggle(file.path)} actions={actions} />)
      ) : (
        <Text style={muted}>None of the PR's files changed.</Text>
      )}
    </>
  );
}

function chapterViewed(draft: ReviewDraft | null, files: PrDetails["files"], path: string) {
  return isViewed(draft, { path, patch: files.find((file) => file.path === path)?.patch });
}

/** Indexes of the chapters whose every file passes `viewed`; those start (or become) folded. */
function chapterIndexes(chapters: { files: string[] }[], viewed: (path: string) => boolean) {
  return chapters.flatMap((chapter, index) => (chapter.files.length && chapter.files.every(viewed) ? [index] : []));
}
