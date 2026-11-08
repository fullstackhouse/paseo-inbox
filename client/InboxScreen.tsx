import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { addCheckout, addPr, findCheckout, groupRuns, isUnconfigured, runNow, skipRun, type Run, type RunState } from "../shared/inbox";
import { inboxSettings } from "../shared/settings";
import { openScreen } from "./nav";
import { useOpenUrl } from "./openUrl";
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
  const [link, setLink] = useState("");
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showSettled, setShowSettled] = useState(false);
  const groups = useMemo(() => groupRuns(view?.runs ?? []), [view]);
  const settled = new Set<RunState>(["done", "skipped", "stale"]);
  const shown = groups.filter((group) => showSettled || !settled.has(group.state));
  const hidden = groups.filter((group) => settled.has(group.state)).reduce((sum, group) => sum + group.runs.length, 0);
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
    const open = () => {
      if (draft || run.reason?.startsWith("review ")) openScreen({ screenId: REVIEW_SCREEN, params: { runId: run.id } });
      else if (run.agentId && navigation) navigation.openAgent({ agentId: run.agentId });
      else if (pr) openUrl(pr.url);
    };
    const tappable = Boolean(draft || run.reason?.startsWith("review ") || (run.agentId && navigation) || pr);
    const clone = run.state === "no-checkout" && pr ? clones[pr.repo] : undefined;
    const detail = draft ? draft.detail : clone ? `Found a clone at ${clone}` : run.state === "no-checkout" && pr ? `No clone of ${pr.repo} on this machine. Add one under Settings → Inbox → Repos on this machine.` : (run.reason ?? run.rule);
    return (
      <Pressable accessibilityRole={tappable ? "button" : undefined} disabled={!tappable} onPress={open} style={({ pressed }) => ({ backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, gap: 4 })}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
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
            {detail}
          </Text>
          {clone && pr ? <Chip theme={theme} label="Use it" active disabled={busy === key} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} onPress={() => void adoptClone(key, pr.repo, clone)} /> : null}
          {run.state !== "running" && run.state !== "queued" && run.state !== "no-checkout" ? (
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
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600", letterSpacing: 0.5 }}>
            {HEADINGS[group.state].toUpperCase()}  {group.runs.length}
          </Text>
          {group.runs.map((run) => (
            <Row key={run.id} run={run} />
          ))}
        </View>
      ))}
      {hidden ? <Chip theme={theme} label={showSettled ? "Hide done, stale and skipped" : `Show done, stale and skipped (${hidden})`} onPress={() => setShowSettled(!showSettled)} style={{ alignSelf: "flex-start" }} /> : null}
    </ScrollView>
  );
}
