import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { deployRefetch, getPrDeployments, getPrUpstream } from "../shared/upstream";
import { Deployments } from "./Deployments";
import { usePrTabTitle } from "./prTabTitle";
import { GitHubTab } from "./GitHubTab";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { fileAt, nextUnviewed, stepFile } from "../shared/filetree";
import { addPr, DISMISSED, isMine, parsePrRef, restoreRun, reviewRunFor, runNow, skipRun, type Run } from "../shared/inbox";
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
  verdictChoices,
  verdictMismatch,
  walkthrough,
  type CommentChange,
  type PrDetails,
  type PrFile,
  type ReviewDraft,
  type Severity,
} from "../shared/review";
import { reviewRecap, type Recap } from "../shared/recap";
import { reanchorReview, type Since } from "../shared/rereview";
import { RecapView, showsRecap, SINCE_FROM } from "./Recap";
import { askMessage } from "../shared/selection";
import { AskBox, CommentCard } from "./CommentCard";
import { HandoffPanel, PreviewPane } from "./Decide";
import { FileDiff, type DiffActions } from "./FileDiff";
import { FileIndex } from "./FileIndex";
import { Markdown } from "./Markdown";
import { openReviewerChat } from "./nav";
import { PrPreview } from "./PrPreview";
import { SelectionAsk } from "./SelectionAsk";
import { useOpenUrl } from "./openUrl";
import { agoText, Chip, MONO, Pill, PrStatePill, STICKY, verdictColor } from "./ui";
import { useInbox } from "./useInbox";
import { useScreenKeys } from "./useScreenKeys";

export { REVIEW_SCREEN } from "./nav";

type Tab = "summary" | "walkthrough" | "since" | "files" | "description" | "github" | "comments" | "preview";

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
  return `${what} ${agoText(iso)}`;
}

export function ReviewScreen({ theme, layout, navigation, params, setTitle }: PluginScreenProps) {
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
  // GitHub refuses approve and request-changes on your own PR, so it only offers comment.
  const own = isMine(pr, view?.me);
  const prLabel = usePrTabTitle(setTitle, pr);

  const fetchDraft = useRpc(getReview);
  const restoreDraft = useRpc(restoreRun);
  const fetchDetails = useRpc(getPrDetails);
  const fetchUpstream = useRpc(getPrUpstream);
  const fetchDeployments = useRpc(getPrDeployments);
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
  const fetchRecap = useRpc(reviewRecap);
  const [recap, setRecap] = useState<Recap | null>(null);
  const since: Since | null = recap?.since ?? null;
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
  const upstream = useQuery({
    queryKey: ["inbox.pr_upstream", run?.itemKey, pr?.headSha, draft?.postedUrl],
    queryFn: () => fetchUpstream({ itemKey: run!.itemKey }),
    enabled: tab === "github" && Boolean(run),
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [closedChapters, setClosedChapters] = useState<Set<number>>(new Set());
  // Actions in flight, per run: a post still going on one review neither blocks nor labels the next one.
  const [pending, setPending] = useState<Record<string, string>>({});
  const busy = pending[runId] ?? null;
  // The run on screen now, for results that land after the human moved to another review.
  const shown = useRef(runId);
  shown.current = runId;
  const scroll = useRef<ScrollView>(null);
  const carried = useRef<string | null>(null);
  // Jump-to-file on native: where the content, the Files list and each file card in it sit (web measures the DOM, see fileTop).
  const contentY = useRef(0);
  const rowY = useRef(0);
  const listY = useRef(0);
  const fileY = useRef(new Map<string, number>());
  const fileNode = useRef(new Map<string, unknown>());
  // Every rendered file card, any tab: where a text selection sits, for "Ask about this".
  const diffNode = useRef(new Map<unknown, string>());
  const content = useRef<View>(null);
  // The file on screen in the Files tab, for the index highlight and j/k/v.
  const [current, setCurrentState] = useState<string | null>(null);
  // Mirrors `current` so key repeats faster than a render step from the newest file.
  const currentRef = useRef<string | null>(null);
  const setCurrent = (path: string | null) => {
    currentRef.current = path;
    setCurrentState(path);
  };
  // A jump in flight: until `until`, layout changes (a viewed file folding, cards mounting) re-aim the
  // scroll at `path`, and scroll events are the jump's own, so they leave `current` on its file.
  const jump = useRef<{ path: string; until: number } | null>(null);
  const jumping = () => Boolean(jump.current && Date.now() < jump.current.until);
  const [tabsHeight, setTabsHeight] = useState(52);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [indexOpen, setIndexOpen] = useState(false);
  const root = useRef<View>(null);

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
    setCurrent(null);
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

  // "Since your review" (the diff since my last review, plus what happened to it): asked once the live head is known, again when the draft moves.
  const liveHead = details && detailsFor === itemKey ? details.headSha : null;
  const draftVersion = draft?.version;
  useEffect(() => {
    if (!runId || !liveHead) return;
    let live = true;
    setRecap(null);
    void fetchRecap({ runId })
      .then((value) => {
        if (!live) return;
        setRecap(value);
        setSinceOpen(new Set(value.since.kind === "changes" ? value.since.files.map((file) => file.path) : []));
      })
      .catch(() => live && setRecap(null));
    return () => {
      live = false;
    };
  }, [fetchRecap, runId, liveHead, draftVersion]);

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
  // Preview deployments: re-read on a new head, and every 30s while one is still deploying.
  const deployments = useQuery({
    queryKey: ["inbox.pr_deployments", run?.itemKey, headSha],
    queryFn: () => fetchDeployments({ itemKey: run!.itemKey }),
    enabled: Boolean(run),
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => deployRefetch(query.state.data),
  });
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
    async (question: string, about: string, quote?: string): Promise<boolean> => {
      try {
        await discuss({ runId, message: askMessage(about, question, quote) });
        if (run?.agentId && navigation) openReviewerChat(navigation, { ...run, agentId: run.agentId }, layout.compact);
        else setNotice("Sent to the reviewer.");
        return true;
      } catch (caught) {
        fail(caught);
        return false;
      }
    },
    [discuss, runId, run, navigation, layout.compact],
  );

  /** The draft a run's RPC returned, kept only while that run is still on screen. */
  const keepDraft = (id: string, value: ReviewDraft) => {
    if (shown.current === id) setDraft(value);
  };
  const actions: DiffActions = {
    editable,
    onChange: async (commentId, change) => {
      const id = runId;
      try {
        keepDraft(id, await changeComment({ runId: id, commentId, ...rpcChange(change) }));
      } catch (caught) {
        if (shown.current === id) fail(caught);
      }
    },
    onDelete: async (commentId) => {
      const id = runId;
      try {
        keepDraft(id, await deleteComment({ runId: id, commentId }));
      } catch (caught) {
        if (shown.current === id) fail(caught);
      }
    },
    onAdd: async (comment) => {
      const id = runId;
      try {
        keepDraft(id, await addComment({ runId: id, ...comment, severity: rpcSeverity(comment.severity) }));
      } catch (caught) {
        if (shown.current === id) fail(caught);
      }
    },
    onAsk: ask,
  };

  /**
   * Runs an action for the run on screen. It's busy (and labelled) for that run only, and its result
   * lands only while that run is still shown: `here()` says so. A failure after the human moved on
   * still shows, named by its PR. The inbox list refreshes in the background, after the button frees.
   */
  const act = async (label: string, action: (here: () => boolean) => Promise<void>) => {
    const id = runId;
    const what = prLabel;
    setPending((current) => ({ ...current, [id]: label }));
    setError(null);
    try {
      await action(() => shown.current === id);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(shown.current === id ? message : `${what}: ${message}`);
    } finally {
      setPending(({ [id]: _done, ...rest }) => rest);
      void refresh();
    }
  };
  // "post-archive" also archives the run's workspace once the review is on GitHub.
  const submit = (archive: boolean) =>
    act(archive ? "post-archive" : "post", async (here) => {
      const result = await post({ runId, archive });
      if (!here()) return;
      setDraft((current) => (current ? { ...current, postedUrl: result.url, postedVerdict: effectiveVerdict(current, own) } : current));
      setNotice(`Posted: ${result.inline} inline${result.folded ? `, ${result.folded} in the review body` : ""}.${result.kept ? ` Kept the workspace: ${result.kept}.` : ""}`);
    });
  // Moves on at once; the dismiss finishes in the background.
  const done = () =>
    act("done", async (here) => {
      if (next) setRunId(next);
      if (run) await dismiss({ itemKey: run.itemKey, rule: run.rule });
      if (here()) setNotice("Dismissed. Later pushes won't draft this PR again.");
    });
  const carry = () =>
    act("reanchor", async (here) => {
      const result = await reanchor({ runId });
      await refresh();
      if (!here()) return;
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
    act("redraft", async (here) => {
      if (run) await redraft({ itemKey: run.itemKey, rule: run.rule });
      if (here()) setNotice("Re-drafting at the new head. It appears in the Inbox when it's ready.");
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

  /** Where a Files-tab card's top sits in the scroll content. */
  const fileTop = (path: string) => {
    // react-native-web reports onLayout on resize only, so a card moved by another folding keeps a stale y: measure the DOM.
    if (Platform.OS === "web") {
      const card = fileNode.current.get(path) as Box | undefined;
      const viewport = scroll.current?.getScrollableNode() as Box | undefined;
      return card && viewport ? card.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop : undefined;
    }
    const y = fileY.current.get(path);
    return y === undefined ? undefined : contentY.current + rowY.current + listY.current + y;
  };
  const scrollToFile = (path: string) => {
    const top = fileTop(path);
    if (top === undefined) return false;
    scroll.current?.scrollTo({ y: Math.max(0, top - tabsHeight - 8), animated: true });
    return true;
  };
  /** Opens a file and brings its card under the tabs. */
  const jumpTo = (path: string | null) => {
    if (!path) return;
    toggleFile(path, true);
    setCurrent(path);
    jump.current = { path, until: Date.now() + 1000 };
  };
  // Cards whose position didn't move fire no onLayout, so a jump also aims once the render settles.
  useEffect(() => {
    if (!jumping()) return;
    const timer = setTimeout(() => jumping() && scrollToFile(jump.current!.path), 60);
    return () => clearTimeout(timer);
  });

  // Desktop keys for the Files tab: j/k next/previous file, v ticks the file on screen.
  const keys = useRef<(key: string) => boolean>(() => false);
  useScreenKeys(root, (key) => keys.current(key));

  /** What a selection starting at `node` is part of, as the question to the reviewer names it. */
  const selectionAbout = (node: unknown) => {
    for (const [card, path] of diffNode.current) if ((card as { contains(other: unknown): boolean }).contains(node)) return `this part of the diff of ${path}`;
    return `this part of ${TAB_ABOUT[tab]}`;
  };

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const pad = layout.compact ? 14 : 24;
  // A wide web pane gets the file tree as a pinned sidebar; elsewhere it's a list above the files you can fold.
  const sidebar = Platform.OS === "web" && !layout.compact && box.width >= 1000;
  const maxWidth = tab === "files" && sidebar ? 1320 : 980;
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
      setPending((current) => ({ ...current, "": "start" }));
      setError(null);
      try {
        const started = await startReview({ ref: prRef });
        await refresh();
        setRunId(started.runId);
      } catch (caught) {
        fail(caught);
      } finally {
        setPending(({ "": _done, ...rest }) => rest);
      }
    };
    return (
      <PrPreview
        theme={theme}
        compact={layout.compact}
        prRef={prRef}
        prLabel={prLabel}
        setTitle={setTitle}
        starting={busy === "start"}
        error={error}
        onStart={() => void start()}
      />
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
  const verdict = draft ? effectiveVerdict(draft, own) : null;
  const mismatch = draft ? verdictMismatch(draft, own) : null;
  const threadsFor = (path: string) => details?.threads.filter((thread) => thread.path === path) ?? [];
  const tabs: { id: Tab; label: string }[] = [
    { id: "summary", label: "Summary" },
    ...(chapters.length ? [{ id: "walkthrough" as const, label: `Walkthrough ${chapters.length}` }] : []),
    ...(since && since.kind !== "none" ? [{ id: "since" as const, label: `Since ${since.base.slice(0, 7)}${since.kind === "changes" ? ` · ${since.files.length}` : ""}` }] : []),
    { id: "files", label: `Files ${details ? files.length : pr.files.length}` },
    { id: "description", label: "Description" },
    { id: "github", label: "Checks & activity" },
    { id: "comments", label: `Your comments ${live.length}` },
    ...(draft && !draft.postedUrl ? [{ id: "preview" as const, label: draft.bodyOverride !== undefined ? "Preview (edited)" : "Preview" }] : []),
  ];

  const viewedCount = files.filter((file) => isViewed(draft, file)).length;
  const canMarkViewed = Boolean(draft && !draft.postedUrl);
  const paths = files.map((file) => file.path);
  const setViewed = (file: PrFile, value: boolean) =>
    void markViewed({ runId, path: file.path, patch: file.patch, viewed: value })
      .then((next) => {
        setDraft(next);
        // Ticking a file folds it away, like GitHub's "Viewed", and its chapter once every file in it is viewed.
        if (!value) return;
        toggleFile(file.path, false);
        const finished = chapterIndexes(
          walkthrough(next, files).map((chapter) => (chapter.files.includes(file.path) ? chapter : { files: [] })),
          (candidate) => chapterViewed(next, files, candidate),
        );
        if (finished.length) setClosedChapters((current) => new Set([...current, ...finished]));
        // In Files, carry on to the next file still to read.
        if (tab === "files") jumpTo(nextUnviewed(paths, file.path, (path) => chapterViewed(next, files, path)));
      })
      .catch(fail);
  keys.current = (key) => {
    if (tab !== "files" || !details) return false;
    if (key === "j" || key === "k") {
      jumpTo(stepFile(paths, currentRef.current, key === "j" ? 1 : -1));
      return true;
    }
    const file = files.find((candidate) => candidate.path === currentRef.current);
    if (key === "v" && file && canMarkViewed) {
      setViewed(file, !isViewed(draft, file));
      return true;
    }
    return false;
  };
  const fileIndex = (
    <FileIndex
      files={files}
      theme={theme}
      current={current}
      viewed={(file) => isViewed(draft, file)}
      comments={(path) => (commentsByFile.get(path) ?? []).filter((comment) => comment.status !== "dropped").length}
      onJump={jumpTo}
      onViewed={canMarkViewed ? setViewed : undefined}
    />
  );
  const fileDiff = (path: string, track = false) => {
    const file = files.find((candidate) => candidate.path === path);
    return file ? (
      <View
        key={path}
        ref={(node) => {
          if (node) diffNode.current.set(node, path);
          else for (const [known, knownPath] of diffNode.current) if (knownPath === path) diffNode.current.delete(known);
          if (!track) return;
          if (node) fileNode.current.set(path, node);
          else fileNode.current.delete(path);
        }}
        onLayout={
          track
            ? (event) => {
                fileY.current.set(path, event.nativeEvent.layout.y);
                if (jumping()) scrollToFile(jump.current!.path);
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
          onViewed={canMarkViewed ? (value) => setViewed(file, value) : undefined}
          stickyTop={tabsHeight}
        />
      </View>
    ) : (
      <Text key={path} style={muted}>
        {path}
      </Text>
    );
  };

  return (
    <View ref={root} style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        ref={scroll}
        stickyHeaderIndices={[1]}
        contentContainerStyle={{ paddingBottom: 24 }}
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          if (width !== box.width || height !== box.height) setBox({ width, height });
        }}
        scrollEventThrottle={64}
        onScroll={(event) => {
          if (tab !== "files" || jumping()) return;
          const tops = new Map(paths.flatMap((path) => (fileTop(path) === undefined ? [] : [[path, fileTop(path)!] as const])));
          const at = fileAt(tops, paths, event.nativeEvent.contentOffset.y + tabsHeight + 12);
          if (at !== current) setCurrent(at);
        }}
      >
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
            {"  ·  "}
            <Text accessibilityRole="button" accessibilityLabel={`Open GitHub checks: ${pr.checks}`} onPress={() => setTab("github")} style={{ color: pr.checks === "passing" ? theme.colors.statusSuccess : pr.checks === "failing" ? theme.colors.statusDanger : pr.checks === "pending" ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>
              {pr.checks === "none" ? "No checks" : `checks ${pr.checks}`}
            </Text>
            {pr.isDraft ? "  ·  draft PR" : ""}
          </Text>
          <Deployments theme={theme} entries={deployments.data} onOpen={openUrl} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {draft && verdict ? (
              <Pill theme={theme} color={verdictColor(theme, verdict)}>
                {verdict} · {draft.confidence}%{!own && draft.verdictOverride ? " (yours)" : ""}
              </Pill>
            ) : null}
            {draft ? <Pill theme={theme} color={theme.colors.foregroundMuted}>{ageLabel("drafted", draft.createdAt)}{draft.reanchored ? ` · ${ageLabel("moved", draft.reanchored.at)}` : ""}</Pill> : null}
            {drafting ? <Pill theme={theme} color={theme.colors.foregroundMuted}>{run.state === "queued" ? "queued" : "drafting…"}</Pill> : null}
            {stale ? <Pill theme={theme} color={theme.colors.statusWarning}>new commits since this draft</Pill> : null}
            {draft?.reviewedVersion && draft.reviewedVersion !== draft.version ? <Pill theme={theme} color={theme.colors.foregroundMuted}>summary written for {draft.reviewedVersion.slice(0, 7)}</Pill> : null}
            {draft?.postedUrl ? <Pill theme={theme} color={theme.colors.statusSuccess}>posted</Pill> : null}
            {details ? <PrStatePill theme={theme} details={details} /> : null}
            {run.trusted === false ? <Pill theme={theme} color={theme.colors.statusWarning}>read-only run: author not trusted</Pill> : null}
            {details?.threads.length ? <Pill theme={theme} color={theme.colors.foregroundMuted}>{details.threads.length} comments from others</Pill> : null}
            <View style={{ flex: 1 }} />
            <Chip theme={theme} label="Open on GitHub ↗" onPress={() => openUrl(pr.url)} />
            {run.agentId && navigation ? <Chip theme={theme} label="Reviewer chat" onPress={() => openReviewerChat(navigation, { ...run, agentId: run.agentId! }, layout.compact)} /> : null}
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
              <Text style={{ ...muted, flex: 1, minWidth: 220 }}>You dismissed this review ({agoText(run.updatedAt)}). Restore it to edit and post it.</Text>
              <Chip theme={theme} active label={busy === "restore" ? "Restoring…" : "Restore"} disabled={Boolean(busy)} onPress={() => void restore()} />
            </View>
          ) : null}
          {notice ? <Text style={{ color: theme.colors.statusSuccess, fontSize: 13 }}>{notice}</Text> : null}
          {error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{error}</Text> : null}
        </View>

        {/* Sticky tabs */}
        <View onLayout={(event) => setTabsHeight(Math.round(event.nativeEvent.layout.height))} style={{ backgroundColor: theme.colors.surface0, borderBottomWidth: 1, borderBottomColor: theme.colors.border, zIndex: 3 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: pad, paddingVertical: 8, gap: 6, flexGrow: 1, justifyContent: layout.compact ? "flex-start" : "center" }}>
            {tabs.map((item) => (
              <Chip key={item.id} theme={theme} label={item.label} active={tab === item.id} onPress={() => setTab(item.id)} />
            ))}
          </ScrollView>
        </View>

        {/* Content */}
        <View ref={content} onLayout={(event) => (contentY.current = event.nativeEvent.layout.y)} style={{ paddingHorizontal: pad, paddingTop: 14, gap: 12, width: "100%", maxWidth, alignSelf: "center" }}>
          {tab === "summary" && showsRecap(recap, draft?.recap ?? recap?.ai ?? null) ? (
            <RecapView recap={recap} ai={draft?.recap ?? recap.ai} theme={theme} onOpen={openUrl} onSince={() => setTab("since")} onFiles={() => setTab("files")} />
          ) : null}
          {!draft && tab !== "description" && tab !== "files" && tab !== "github" ? (
            drafting ? (
              <View style={{ gap: 10, alignItems: "flex-start", backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 14 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <ActivityIndicator color={theme.colors.foregroundMuted} />
                  <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>{run.state === "queued" ? "Waiting for a free slot" : "The reviewer is drafting this review"}</Text>
                </View>
                <Text style={muted}>
                  The summary, verdict and comments appear here when the draft is saved{run.state === "running" ? ` (started ${agoText(run.updatedAt)})` : ""}. Read the Files and Description in the meantime.
                </Text>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Chip theme={theme} label="Files" style={small} textStyle={{ fontSize: 12 }} onPress={() => setTab("files")} />
                  {run.agentId && navigation ? <Chip theme={theme} label="Watch the reviewer" style={small} textStyle={{ fontSize: 12 }} onPress={() => openReviewerChat(navigation, { ...run, agentId: run.agentId! }, layout.compact)} /> : null}
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
              <View onLayout={(event) => (rowY.current = event.nativeEvent.layout.y)} style={{ flexDirection: sidebar ? "row" : "column", alignItems: sidebar ? "flex-start" : "stretch", gap: sidebar ? 20 : 12 }}>
                {sidebar ? (
                  <ScrollView
                    style={[{ width: 300, flexGrow: 0, flexShrink: 0, maxHeight: Math.max(240, box.height - tabsHeight - 24) }, STICKY(tabsHeight + 12)]}
                    contentContainerStyle={{ paddingBottom: 8 }}
                  >
                    {fileIndex}
                  </ScrollView>
                ) : (
                  <View style={{ gap: 8, backgroundColor: theme.colors.surface1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 }}>
                    <Pressable accessibilityRole="button" accessibilityState={{ expanded: indexOpen }} onPress={() => setIndexOpen(!indexOpen)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
                        File list <Text style={{ ...muted, fontWeight: "400" }}>· {viewedCount}/{files.length} viewed</Text>
                      </Text>
                      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{indexOpen ? "▾" : "▸"}</Text>
                    </Pressable>
                    {indexOpen ? fileIndex : null}
                  </View>
                )}
                <View onLayout={(event) => (listY.current = event.nativeEvent.layout.y)} style={{ flex: sidebar ? 1 : undefined, minWidth: 0, gap: 12 }}>
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    <Chip theme={theme} label="Expand all" onPress={() => setOpenFiles(new Set(files.map((file) => file.path)))} />
                    <Chip theme={theme} label="Collapse all" onPress={() => setOpenFiles(new Set())} />
                    {live.length ? <Chip theme={theme} label="Only commented" onPress={() => setOpenFiles(new Set(live.map((comment) => comment.path)))} /> : null}
                    <Chip theme={theme} label="Not viewed" onPress={() => setOpenFiles(new Set(files.filter((file) => !isViewed(draft, file)).map((file) => file.path)))} />
                    <Text style={{ ...muted, alignSelf: "center" }}>
                      {viewedCount}/{files.length} viewed
                    </Text>
                    {Platform.OS === "web" && !layout.compact ? (
                      <Text style={{ ...muted, fontSize: 12, alignSelf: "center", marginLeft: "auto" }}>
                        <Text style={{ fontFamily: MONO }}>j</Text>/<Text style={{ fontFamily: MONO }}>k</Text> next/previous file{canMarkViewed ? " · " : ""}
                        {canMarkViewed ? <Text style={{ fontFamily: MONO }}>v</Text> : null}
                        {canMarkViewed ? " viewed" : ""}
                      </Text>
                    ) : null}
                  </View>
                  {files.map((file) => fileDiff(file.path, true))}
                </View>
              </View>
            ) : (
              <ActivityIndicator color={theme.colors.foregroundMuted} />
            )
          ) : null}

          {tab === "description" ? (
            details ? (
              <>
                <Text style={muted}>
                  by {details.author} · opened {agoText(details.createdAt)}
                </Text>
                <Markdown text={details.body} theme={theme} />
              </>
            ) : (
              <ActivityIndicator color={theme.colors.foregroundMuted} />
            )
          ) : null}

          {tab === "github" ? (
            <GitHubTab key={run.itemKey} data={upstream.data} error={upstream.error} loading={upstream.isFetching} onRefresh={() => {
              void upstream.refetch();
              void deployments.refetch();
            }} pr={pr} theme={theme} />
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
                    setTab("files");
                    jumpTo(comment.path);
                  }}
                />
              ))
            ) : (
              <Text style={muted}>No inline comments. Open a file and tap a line to add one.</Text>
            )
          ) : null}
          {editable ? <SelectionAsk theme={theme} container={content} about={selectionAbout} onAsk={ask} resetKey={`${runId} ${tab}`} /> : null}
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
                  act("handoff", async (here) => {
                    const result = await handoff({ runId, ...input });
                    if (!here()) return;
                    setHandingOff(false);
                    setNotice(`Handed off to ${input.to.startsWith("@") ? input.to : `@${input.to}`}.`);
                    setDraft((current) => (current ? { ...current, postedUrl: result.url } : current));
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
              {verdictChoices(own).map((option) => (
                <Chip
                  key={option}
                  theme={theme}
                  label={option}
                  active={verdict === option}
                  disabled={!editable}
                  style={small}
                  textStyle={{ fontSize: 12 }}
                  onPress={() =>
                    void act("verdict", async (here) => {
                      // Picked at once; the saved draft replaces it (the chat pill's Post item names the verdict, via the refresh).
                      const before = draft;
                      setDraft((current) => (current ? { ...current, verdictOverride: option } : current));
                      try {
                        const saved = await setVerdict({ runId, verdict: option });
                        if (here()) setDraft(saved);
                      } catch (caught) {
                        if (here()) setDraft(before);
                        throw caught;
                      }
                    })
                  }
                />
              ))}
              {own ? (
                <Text style={{ ...muted, flexShrink: 1 }} numberOfLines={2}>
                  Your own PR: GitHub doesn't let you approve it or request changes on it.
                </Text>
              ) : null}
              <View style={{ flex: 1 }} />
              <Chip theme={theme} label="Hand off" active={handingOff} disabled={Boolean(busy) || !run.agentId} style={small} textStyle={{ fontSize: 12 }} onPress={() => setHandingOff(!handingOff)} />
              <Chip theme={theme} label={busy === "done" ? "…" : next ? "Dismiss, next" : "Dismiss"} disabled={Boolean(busy)} style={small} textStyle={{ fontSize: 12 }} onPress={() => void done()} />
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Text style={{ ...muted, flex: 1 }} numberOfLines={2}>
                {stale ? `Posts on ${draft.version.slice(0, 7)}, where it was drafted; GitHub marks comments outdated where the code changed since. ` : ""}{`${live.length} comment${live.length === 1 ? "" : "s"}${folded ? ` (${folded} in the body)` : ""}${draft.comments.length > live.length ? ` · ${draft.comments.length - live.length} dropped` : ""}`}
              </Text>
              {/* Most reviews end with the post, so Post & archive leads; plain Post keeps the reviewer to talk to. */}
              {run.workspaceId ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Post the review to GitHub as ${verdict} and keep the workspace`}
                  disabled={!editable || Boolean(busy)}
                  onPress={() => void submit(false)}
                  style={{ borderWidth: 1, borderColor: theme.colors.border, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, opacity: !editable || busy ? 0.5 : 1 }}
                >
                  <Text style={{ color: theme.colors.foreground, fontWeight: "600", fontSize: 14 }}>{busy === "post" ? "Posting…" : "Post"}</Text>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={run.workspaceId ? `Post the review to GitHub as ${verdict} and archive the workspace` : `Post the review to GitHub as ${verdict}`}
                disabled={!editable || Boolean(busy)}
                onPress={() => void submit(Boolean(run.workspaceId))}
                style={{ backgroundColor: verdictColor(theme, verdict), paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10, opacity: !editable || busy ? 0.5 : 1 }}
              >
                <Text style={{ color: theme.colors.accentForeground, fontWeight: "600", fontSize: 14 }}>
                  {busy === "post-archive" ? "Posting…" : run.workspaceId ? "Post & archive" : `Post as ${verdict}`}
                </Text>
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

const TAB_ABOUT: Record<Tab, string> = {
  summary: "your summary",
  walkthrough: "your walkthrough",
  since: "the changes since your last look",
  files: "the files",
  description: "the PR description",
  github: "the checks and activity",
  comments: "your comments",
  preview: "the review as it will post",
};

// The client compiles without the DOM lib; the two DOM shapes `fileTop` reads on web.
type Box = { getBoundingClientRect(): { top: number }; scrollTop: number };

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
  const what = `${SINCE_FROM[since.from]}${since.at ? ` (${agoText(since.at)})` : ""}, ${since.base.slice(0, 7)}`;
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
        {since.hidden ? `, plus ${since.incomplete ? "at least " : ""}${since.hidden} the PR doesn't change (merged from the base branch), left out` : ""}.
      </Text>
      {since.incomplete ? <Text style={{ color: theme.colors.statusWarning, fontSize: 13 }}>GitHub lists at most 300 changed files and the full list couldn't be read, so some of the PR's files may be missing here. Check them in Files.</Text> : null}
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
