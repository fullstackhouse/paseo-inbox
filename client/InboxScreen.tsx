import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { addPr, groupRuns, runNow, skipRun, type Run, type RunState } from "../shared/inbox";
import { postReview } from "../shared/review";
import { openScreen } from "./nav";
import { REVIEW_SCREEN } from "./ReviewScreen";
import { ago, Chip, MONO, Pill, verdictColor } from "./ui";
import { useInbox } from "./useInbox";

export const INBOX_SCREEN = "inbox";

const HEADINGS: Record<RunState, string> = {
  "needs-decision": "Needs a decision",
  running: "Running",
  queued: "Queued",
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

export function InboxScreen({ theme, layout, navigation }: PluginScreenProps) {
  const { view, error, polling, refresh, pollNow } = useInbox();
  const rerun = useRpc(runNow);
  const dismiss = useRpc(skipRun);
  const add = useRpc(addPr);
  const post = useRpc(postReview);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [posting, setPosting] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const groups = useMemo(() => groupRuns(view?.runs ?? []), [view]);
  const settled = new Set<RunState>(["done", "skipped", "stale"]);
  const shown = groups.filter((group) => showSettled || !settled.has(group.state));
  const hidden = groups.filter((group) => settled.has(group.state)).reduce((sum, group) => sum + group.runs.length, 0);
  const pad = layout.compact ? 12 : 24;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const candidates = (view?.runs ?? []).filter(postable);
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
    const open = () => {
      if (draft || run.reason?.startsWith("review ")) openScreen({ screenId: REVIEW_SCREEN, params: { runId: run.id } });
      else if (run.agentId && navigation) navigation.openAgent({ agentId: run.agentId });
    };
    const tappable = Boolean(draft || run.reason?.startsWith("review ") || (run.agentId && navigation));
    const checked = picked.has(run.id);
    return (
      <Pressable accessibilityRole={tappable ? "button" : undefined} disabled={!tappable} onPress={open} style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, gap: 4 })}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {postable(run) ? (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityLabel={`Select ${run.itemKey} for posting`}
              accessibilityState={{ checked, disabled: posting !== null }}
              disabled={posting !== null}
              hitSlop={8}
              onPress={() => toggle(run.id)}
              style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: checked ? theme.colors.accent : theme.colors.foregroundMuted, backgroundColor: checked ? theme.colors.accent : "transparent", alignItems: "center", justifyContent: "center" }}
            >
              {checked ? <Text style={{ color: theme.colors.accentForeground, fontSize: 12, fontWeight: "700", lineHeight: 14 }}>✓</Text> : null}
            </Pressable>
          ) : null}
          <Text style={{ ...muted, fontFamily: MONO, fontSize: 12, flex: 1 }} numberOfLines={1}>
            {run.itemKey.replace(/^[^/]+\//, "")}
            {pr?.author ? `  ·  ${pr.author}` : ""}
          </Text>
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {draft ? <Pill theme={theme} color={verdictColor(theme, draft.verdict)}>{draft.verdict}</Pill> : null}
          <Text style={{ ...muted, flex: 1 }} numberOfLines={2}>
            {draft ? draft.detail : run.reason ?? run.rule}
          </Text>
          {run.state !== "running" && run.state !== "queued" ? (
            <Chip theme={theme} label={run.agentId ? "Rerun" : "Run now"} disabled={busy === key} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => void act(key, () => rerun({ itemKey: run.itemKey, rule: run.rule }))} />
          ) : null}
          {run.state !== "running" && run.state !== "done" ? (
            <Chip theme={theme} label="Dismiss" disabled={busy === key} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => void act(key, () => dismiss({ itemKey: run.itemKey, rule: run.rule }))} />
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 14, width: "100%", maxWidth: 900, alignSelf: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ ...muted, flex: 1 }}>{view?.lastPollAt ? `Polled ${ago(view.lastPollAt)} ago` : "Not polled yet"}</Text>
        <Chip theme={theme} label={polling ? "Polling…" : "Poll now"} disabled={polling} onPress={() => void pollNow()} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          value={link}
          onChangeText={setLink}
          placeholder="Paste a PR link to review it"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => link.trim() && void submitLink()}
          style={{ flex: 1, color: theme.colors.foreground, fontSize: 14, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 }}
        />
        <Chip theme={theme} label={adding ? "Adding…" : "Review"} disabled={adding || !link.trim()} onPress={() => void submitLink()} />
      </View>
      {[error, actionError, ...(view?.errors ?? [])].filter(Boolean).map((message) => (
        <Text key={message} style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{message}</Text>
      ))}
      {view && !shown.length ? <Text style={muted}>Nothing to do.</Text> : null}
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
      {hidden ? <Chip theme={theme} label={showSettled ? "Hide done, stale and skipped" : `Show done, stale and skipped (${hidden})`} onPress={() => setShowSettled(!showSettled)} style={{ alignSelf: "flex-start" }} /> : null}
    </ScrollView>
  );
}
