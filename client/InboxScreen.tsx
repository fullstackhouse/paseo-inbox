import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { groupRuns, runNow, skipRun, type Run, type RunState } from "../shared/inbox";
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

export function InboxScreen({ theme, layout, navigation }: PluginScreenProps) {
  const { view, error, polling, refresh, pollNow } = useInbox();
  const run = useRpc(runNow);
  const skip = useRpc(skipRun);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const groups = useMemo(() => groupRuns(view?.runs ?? []), [view]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 24, gap: 16 },
      bar: { flexDirection: "row" as const, alignItems: "center" as const, justifyContent: "space-between" as const, gap: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      error: { color: theme.colors.statusDanger, fontSize: 13 },
      heading: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.5 },
      card: { backgroundColor: theme.colors.surface1, borderRadius: 10, padding: 12, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: 15, fontWeight: "500" as const },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 4 },
      button: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 },
      primary: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.accent },
      buttonText: { color: theme.colors.foreground, fontSize: 13 },
      primaryText: { color: theme.colors.accentForeground, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

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

  const Button = ({ label, onPress, primary, disabled }: { label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[primary ? styles.primary : styles.button, disabled ? { opacity: 0.5 } : null]}>
      <Text style={primary ? styles.primaryText : styles.buttonText}>{label}</Text>
    </Pressable>
  );

  const Card = ({ item }: { item: Run }) => {
    const pr = view?.items[item.itemKey]?.pr;
    const key = `${item.itemKey}|${item.rule}`;
    const disabled = busy === key;
    return (
      <View style={styles.card}>
        <Text style={styles.title} numberOfLines={2}>{pr?.title ?? item.itemKey}</Text>
        <Text style={styles.muted}>
          {item.itemKey} · {item.version.slice(0, 7)} · {item.rule} · {ago(item.updatedAt)}
        </Text>
        {item.reason ? <Text style={styles.muted}>{item.reason}</Text> : null}
        <View style={styles.actions}>
          {item.agentId && navigation ? <Button primary label="Open agent" onPress={() => navigation.openAgent({ agentId: item.agentId! })} /> : null}
          {pr ? <Button label="PR" onPress={() => void Linking.openURL(pr.url)} /> : null}
          {item.state !== "running" && item.state !== "queued" ? (
            <Button label={item.agentId ? "Rerun" : "Run now"} disabled={disabled} onPress={() => void act(key, () => run({ itemKey: item.itemKey, rule: item.rule }))} />
          ) : null}
          {item.state !== "running" && item.state !== "done" ? (
            <Button label="Dismiss" disabled={disabled} onPress={() => void act(key, () => skip({ itemKey: item.itemKey, rule: item.rule }))} />
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.bar}>
        <Text style={styles.muted}>{view?.lastPollAt ? `Last poll ${ago(view.lastPollAt)}` : "Not polled yet"}</Text>
        <Button label={polling ? "Polling…" : "Poll now"} disabled={polling} onPress={() => void pollNow()} />
      </View>
      {[error, actionError, ...(view?.errors ?? [])].filter(Boolean).map((message) => (
        <Text key={message} style={styles.error}>{message}</Text>
      ))}
      {view && !groups.length ? <Text style={styles.muted}>Nothing to do.</Text> : null}
      {groups.map((group) => (
        <View key={group.state} style={{ gap: 8 }}>
          <Text style={styles.heading}>
            {HEADINGS[group.state]} ({group.runs.length})
          </Text>
          {group.runs.map((item) => (
            <Card key={item.id} item={item} />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
