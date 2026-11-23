import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { addCheckout, addPr, doneStatus, failureStatus, findCheckout, type DoneTone, groupRuns, isMine, isUnconfigured, listedRuns, matchesQuery, SETTLED_STATES, whoseCounts, type Whose, opensReview, parsePrRef, runNow, runningDetail, skipRun, type Run, type RunState } from "../shared/inbox";
import { postReview } from "../shared/review";
import { inboxSettings } from "../shared/settings";
import { openScreen } from "./nav";
import { useOpenUrl } from "./openUrl";
import { REVIEW_SCREEN } from "./ReviewScreen";
import { ago, agoText, Chip, MONO, Pill, verdictColor } from "./ui";
import { useInbox } from "./useInbox";

export const INBOX_SCREEN = "inbox";

const HEADINGS: Record<RunState, string> = {
  "needs-decision": "Needs a decision",
  running: "Running",
  queued: "Queued",
  manual: "Waiting for Run now",
  "no-checkout": "No local checkout",
  failed: "Failed",
  stale: "Stale",
  done: "Done",
  skipped: "Skipped",
};

/** `review drafted: approve · 90% · 2 nit` → verdict and the rest. */
function drafted(run: Run): { verdict: string; detail: string } | null {
  const match = /^review drafted: ([\w-]+) · (.*)$/.exec(run.reason ?? "");
  return match ? { verdict: match[1]!, detail: match[2]! } : null;
}

/** A drafted review still waiting for the human: the only rows bulk Post can send. */
const postable = (run: Run) => run.state === "needs-decision" && drafted(run) !== null;

const toneColor = (theme: PluginScreenProps["theme"], tone: DoneTone) =>
  tone === "success" ? theme.colors.statusSuccess : tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;

const FAILURE_LINE = 18;

/**
 * A failure's reason in two lines, with Show more once the whole text runs longer. An invisible copy
 * of the full text measures that. `expanded` lives in the screen: rows remount on every refresh.
 */
function FailureText({ theme, color, text, expanded, onToggle }: { theme: PluginScreenProps["theme"]; color: string; text: string; expanded: boolean; onToggle: () => void }) {
  const [fullHeight, setFullHeight] = useState(0);
  const style = { color, fontSize: 13, lineHeight: FAILURE_LINE };
  return (
    <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 220, minWidth: 0, alignItems: "flex-start" }}>
      <Text style={{ ...style, alignSelf: "stretch" }} numberOfLines={expanded ? undefined : 2}>
        {text}
      </Text>
      <Text aria-hidden style={{ ...style, position: "absolute", left: 0, right: 0, opacity: 0, pointerEvents: "none" }} onLayout={(event) => setFullHeight(event.nativeEvent.layout.height)}>
        {text}
      </Text>
      {fullHeight > FAILURE_LINE * 2 + 1 ? (
        <Pressable accessibilityRole="button" hitSlop={6} onPress={onToggle}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", marginTop: 2 }}>{expanded ? "Show less" : "Show more"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function InboxScreen({ theme, layout, navigation }: PluginScreenProps) {
  const { view, error, polling, refresh, pollNow } = useInbox();
  const rerun = useRpc(runNow);
  const dismiss = useRpc(skipRun);
  const add = useRpc(addPr);
  const find = useRpc(findCheckout);
  const addToFile = useRpc(addCheckout);
  const settings = useSettings(inboxSettings);
  const openUrl = useOpenUrl();
  // Repo → a clone found on disk (null: none), for the runs waiting on a checkout.
  const [clones, setClones] = useState<Record<string, string | null>>({});
  const post = useRpc(postReview);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const [whose, setWhose] = useState<Whose>("all");
  // The link field doubles as search: while it holds text, every run that matches shows, settled ones too.
  const query = link.trim();
  // The chips filter the list once a poll knows the login; a search ignores them (`listedRuns`).
  const filtered = useMemo(() => (view ? listedRuns(whose, view, query) : []), [view, whose, query]);
  const counts = useMemo(() => (view?.me ? whoseCounts(view) : null), [view]);
  const groups = useMemo(
    () => (query ? groupRuns(filtered).map((group) => ({ ...group, runs: group.runs.filter((run) => matchesQuery(run, view?.items[run.itemKey]?.pr, query)) })).filter((group) => group.runs.length) : groupRuns(filtered)),
    [view, filtered, query],
  );
  const shown = groups.filter((group) => query || showSettled || !SETTLED_STATES.has(group.state));
  const hidden = groups.filter((group) => SETTLED_STATES.has(group.state)).reduce((sum, group) => sum + group.runs.length, 0);
  const missing = useMemo(() => [...new Set((view?.runs ?? []).filter((run) => run.state === "no-checkout").map((run) => view?.items[run.itemKey]?.pr.repo).filter((repo): repo is string => Boolean(repo)))].sort().join(","), [view]);
  useEffect(() => {
    if (!missing) return;
    let live = true;
    void Promise.all(missing.split(",").map(async (repo) => [repo, (await find({ repo }).catch(() => ({ path: null }))).path] as const)).then((found) => live && setClones(Object.fromEntries(found)));
    return () => {
      live = false;
    };
  }, [missing, find]);
  const pad = layout.compact ? 12 : 24;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  // Bulk Post sends only drafts the current filter shows.
  const candidates = filtered.filter(postable);
  // A run that got posted, dismissed or re-drafted elsewhere drops out of the selection.
  const selected = candidates.filter((run) => picked.has(run.id));
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  /** One `inbox.review_post` per run, in order: each still checks the live head and refuses a stale draft. */
  const postSelected = async () => {
    setActionError(null);
    const failures: string[] = [];
    for (const [index, run] of selected.entries()) {
      setPosting(`Posting ${index + 1}/${selected.length}…`);
      try {
        await post({ runId: run.id });
        setPicked((prev) => {
          const next = new Set(prev);
          next.delete(run.id);
          return next;
        });
      } catch (caught) {
        failures.push(`${run.itemKey.replace(/^[^/]+\//, "")}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
    }
    setPosting(null);
    if (failures.length) setActionError(`Not posted: ${failures.join("; ")}`);
    await refresh();
  };

  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  };

  // Settings win once they hold sources or rules (the server's rule too); otherwise the legacy inbox.json applies.
  const adoptClone = (key: string, repo: string, path: string) =>
    act(key, async () => {
      if (settings.status === "ready" && !isUnconfigured(settings.values)) {
        if (!(await settings.save({ ...settings.values, checkouts: { ...settings.values.checkouts, [repo]: path } }, settings.revision))) throw new Error(settings.saveError ?? "Couldn't save settings");
        await pollNow();
      } else await addToFile({ repo, path });
    });

  const submitLink = async () => {
    setAdding(true);
    setActionError(null);
    try {
      await add({ ref: link.trim() });
      setLink("");
      await refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAdding(false);
    }
  };

  const Row = ({ run }: { run: Run }) => {
    const pr = view?.items[run.itemKey]?.pr;
    const draft = drafted(run);
    const key = `${run.itemKey}|${run.rule}`;
    const rowBusy = busy === key || Boolean(busy?.startsWith(`${key}:`));
    const open = () => {
      if (draft || opensReview(run, view)) openScreen({ screenId: REVIEW_SCREEN, params: { runId: run.id } });
      else if (run.agentId && navigation) navigation.openAgent({ agentId: run.agentId });
      else if (pr) openUrl(pr.url);
    };
    const tappable = Boolean(draft || opensReview(run, view) || (run.agentId && navigation) || pr);
    const clone = run.state === "no-checkout" && pr ? clones[pr.repo] : undefined;
    const running = run.state === "running";
    const ended = doneStatus(run);
    const failure = failureStatus(run);
    const detail = draft ? draft.detail : ended ? (ended.detail ?? run.rule) : running ? runningDetail(run, view) : clone ? `Found a clone at ${clone}` : run.state === "no-checkout" && pr ? `No clone of ${pr.repo} on this machine. Add one under Settings → Inbox → Repos on this machine.` : (run.reason ?? run.rule);
    const checked = picked.has(run.id);
    const canRun = run.state !== "running" && run.state !== "queued" && run.state !== "no-checkout";
    const canDismiss = run.state !== "running" && run.state !== "done";
    // The card is a plain container: on web a pressable renders a <button>, and a <button> can't hold the
    // checkbox and the action chips. The open target is the PR's text; the controls sit beside it.
    return (
      <View style={{ backgroundColor: theme.colors.surface1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          {postable(run) ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={`Select ${run.itemKey} for posting`}
              accessibilityState={{ checked, disabled: posting !== null }}
              disabled={posting !== null}
              hitSlop={8}
              onPress={() => toggle(run.id)}
              style={{ marginTop: 1, width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted, backgroundColor: checked ? theme.colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}
            >
              {checked ? <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700", lineHeight: 14 }}>✓</Text> : null}
            </Pressable>
          ) : null}
          <Pressable accessibilityRole={tappable ? "button" : undefined} disabled={!tappable} onPress={open} style={({ pressed }) => ({ flex: 1, minWidth: 0, gap: 4, opacity: pressed ? 0.6 : 1 })}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
                <Text style={{ ...muted, fontFamily: MONO, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                  {run.itemKey.replace(/^[^/]+\//, "")}
                  {pr?.author && !isMine(pr, view?.me) ? `  ·  ${pr.author}` : ""}
                </Text>
                {/* accent on accentForeground: themes pair them for contrast; accent text alone fades on dark surfaces. */}
                {isMine(pr, view?.me) ? <Text style={{ color: theme.colors.accentForeground, backgroundColor: theme.colors.accent, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 1, fontSize: 11, fontWeight: "600", overflow: "hidden" }}>you</Text> : null}
              </View>
              {pr ? (
                <Text style={{ fontFamily: MONO, fontSize: 12 }}>
                  <Text style={{ color: theme.colors.statusSuccess }}>+{pr.additions}</Text> <Text style={{ color: theme.colors.statusDanger }}>−{pr.deletions}</Text>
                </Text>
              ) : null}
              <Text style={{ ...muted, fontSize: 12 }}>{ago(run.updatedAt)}</Text>
            </View>
            <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "500", lineHeight: 20 }} numberOfLines={2}>
              {pr?.title ?? run.itemKey}
            </Text>
            {failure ? null : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {draft ? <Pill theme={theme} color={verdictColor(theme, draft.verdict)}>{draft.verdict}</Pill> : null}
                {ended ? <Pill theme={theme} color={toneColor(theme, ended.tone)} outlined={ended.tone === "muted"}>{ended.label}</Pill> : null}
                {running ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} accessibilityLabel="Running" /> : null}
                <Text style={{ ...muted, flex: 1 }} numberOfLines={2}>
                  {detail}
                </Text>
              </View>
            )}
          </Pressable>
        </View>
        {/* Outside the open button: Show more is a control of its own. */}
        {failure ? (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
            <Pill theme={theme} color={toneColor(theme, failure.tone)} outlined={failure.tone === "muted"}>{failure.label}</Pill>
            {/* No reason: the pill alone. The rule name in its colour would read as the error. */}
            {failure.detail ? (
              <FailureText theme={theme} color={toneColor(theme, failure.tone)} text={failure.detail} expanded={expanded.has(run.id)} onToggle={() => setExpanded((ids) => (ids.has(run.id) ? new Set([...ids].filter((id) => id !== run.id)) : new Set([...ids, run.id])))} />
            ) : null}
          </View>
        ) : null}
        {(clone && pr) || canRun || canDismiss ? (
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            {clone && pr ? <Chip theme={theme} label="Use it" active disabled={rowBusy} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => void adoptClone(key, pr.repo, clone)} /> : null}
            {canRun ? (
              <Chip theme={theme} label={busy === `${key}:run` ? "Starting…" : run.agentId ? "Rerun" : "Run now"} disabled={rowBusy} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => void act(`${key}:run`, () => rerun({ itemKey: run.itemKey, rule: run.rule }))} />
            ) : null}
            {canDismiss ? (
              <Chip theme={theme} label={busy === `${key}:dismiss` ? "Dismissing…" : "Dismiss"} disabled={rowBusy} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => void act(`${key}:dismiss`, () => dismiss({ itemKey: run.itemKey, rule: run.rule }))} />
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 14, width: "100%", maxWidth: 900, alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ ...muted, flex: 1 }}>{view?.lastPollAt ? `Polled ${agoText(view.lastPollAt)}` : "Not polled yet"}</Text>
        <Chip theme={theme} label={polling ? "Polling…" : "Poll now"} disabled={polling} onPress={() => void pollNow()} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="Search, or paste a PR link to review it"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => parsePrRef(query) && void submitLink()}
          style={{ flex: 1, color: theme.colors.foreground, fontSize: 14, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 }}
        />
        <Chip theme={theme} label={adding ? "Adding…" : "Review"} disabled={adding || !parsePrRef(query)} onPress={() => void submitLink()} />
      </View>
      {counts ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {(
            [
              ["all", "All"],
              ["review", "To review"],
              ["mine", "Mine"],
            ] as const
          ).map(([key, label]) => (
            <Chip key={key} theme={theme} label={`${label} ${counts[key]}`} active={whose === key} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => setWhose(key)} />
          ))}
        </View>
      ) : null}
      {[error, actionError, ...(view?.errors ?? [])].filter(Boolean).map((message) => (
        <Text key={message} style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{message}</Text>
      ))}
      {view && !shown.length ? <Text style={muted}>{!query ? "Nothing to do." : parsePrRef(query) ? "No run for this PR yet. Review queues one." : "No run matches."}</Text> : null}
      {shown.map((group) => (
        <View key={group.state} style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.5, flex: 1 }}>
              {HEADINGS[group.state].toUpperCase()}  {group.runs.length}
            </Text>
            {group.state === "needs-decision" && candidates.length > 1 ? (
              <Chip
                theme={theme}
                label={selected.length === candidates.length ? "Select none" : `Select all ${candidates.length} drafts`}
                disabled={posting !== null}
                style={{ paddingVertical: 4, paddingHorizontal: 10 }}
                textStyle={{ fontSize: 12 }}
                onPress={() => setPicked(selected.length === candidates.length ? new Set() : new Set(candidates.map((run) => run.id)))}
              />
            ) : null}
            {group.state === "needs-decision" && selected.length ? (
              <Chip theme={theme} active label={posting ?? `Post ${selected.length} review${selected.length === 1 ? "" : "s"}`} disabled={posting !== null} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => void postSelected()} />
            ) : null}
          </View>
          {group.runs.map((run) => (
            <Row key={run.id} run={run} />
          ))}
        </View>
      ))}
      {hidden && !query ? <Chip theme={theme} label={showSettled ? "Hide done, stale and skipped" : `Show done, stale and skipped (${hidden})`} onPress={() => setShowSettled(!showSettled)} style={{ alignSelf: "flex-start" }} /> : null}
    </ScrollView>
  );
}
