import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { Severity } from "../shared/review";
import type { DraftCard, DraftChange } from "../shared/timeline";
import { openScreen } from "./nav";
import { REVIEW_SCREEN } from "./ReviewScreen";
import { MONO, Pill, severityColor, verdictColor } from "./ui";
import { snapshot, subscribe } from "./useInbox";

/** Comments shown before "N more" on a freshly saved draft. */
const FOLDED = 3;

type Styles = ReturnType<typeof makeStyles>;

/**
 * Stands in for an `inbox_review_draft` / `inbox_review_revise` call in the reviewer's chat: what the
 * call changed in the draft (comments added, edited, removed; verdict and fields set; what was refused),
 * with a button to the review. The run comes from the shared inbox view the review pill keeps polling.
 */
export function DraftChangeCard({ item, theme, layout, agentId }: PluginTimelineItemProps<DraftCard>) {
  const card = item.data;
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const view = useSyncExternalStore(subscribe, snapshot);
  const runId = view && [...view.runs].reverse().find((run) => run.agentId === agentId)?.id;
  const [unfolded, setUnfolded] = useState(false);
  const changes = card.tool === "draft" && !unfolded ? card.changes.slice(0, FOLDED) : card.changes;
  const hidden = card.changes.length - changes.length;
  const empty = card.tool === "revise" && !card.changes.length && !card.fields.length && card.verdict === null && card.confidence === null;

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Icon name="ClipboardCheck" size={16} color={theme.colors.foregroundMuted} />
        <Text style={styles.title} numberOfLines={1}>
          {card.tool === "draft" ? "Review draft saved" : "Review draft revised"}
        </Text>
        {card.verdict && (
          <Pill theme={theme} color={verdictColor(theme, card.verdict)}>
            {card.verdict}
            {card.confidence !== null ? ` · ${card.confidence}%` : ""}
          </Pill>
        )}
        {!card.verdict && card.confidence !== null && <Pill theme={theme} color={theme.colors.foregroundMuted}>{`${card.confidence}%`}</Pill>}
      </View>
      {card.headline && <Text style={styles.headline}>{card.headline}</Text>}
      {changes.map((change, index) => (
        <ChangeRow key={`${change.op}-${"id" in change ? change.id : ""}-${index}`} change={change} styles={styles} theme={theme} />
      ))}
      {hidden > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setUnfolded(true)} hitSlop={6}>
          <Text style={styles.link}>{`${hidden} more comment${hidden === 1 ? "" : "s"}`}</Text>
        </Pressable>
      )}
      {card.fields.length > 0 && <Text style={styles.muted}>{`Updated the ${joinWords(card.fields)}`}</Text>}
      {empty && <Text style={styles.muted}>Nothing changed</Text>}
      {card.refused.map((reason) => (
        <Text key={reason} style={styles.refused}>{`Refused ${reason}`}</Text>
      ))}
      {runId && (
        <View style={styles.footer}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open review"
            onPress={() => openScreen({ screenId: REVIEW_SCREEN, params: { runId } })}
            style={styles.button}
          >
            <Text style={styles.buttonText}>Open review</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const MARKS = { add: { icon: "Plus", label: "Added" }, edit: { icon: "Pencil", label: "Edited" }, drop: { icon: "Trash2", label: "Removed" } } as const;

function ChangeRow({ change, styles, theme }: { change: DraftChange; styles: Styles; theme: PluginTheme }) {
  const [open, setOpen] = useState(false);
  const mark = MARKS[change.op];
  const tone = change.op === "drop" ? theme.colors.foregroundMuted : change.op === "add" ? theme.colors.statusSuccess : theme.colors.accent;
  const body = change.op === "drop" ? undefined : change.body;
  return (
    <Pressable accessibilityRole="button" disabled={!body} onPress={() => setOpen(!open)} style={styles.change}>
      <View style={styles.changeHeader}>
        <Icon name={mark.icon} size={13} color={tone} />
        <Text style={styles.changeLabel}>{mark.label}</Text>
        {"id" in change && change.id && <Text style={styles.id}>{change.id}</Text>}
        {change.op === "add" && (
          <Text style={styles.path} numberOfLines={1}>
            {change.line ? `${change.path}:${change.line}` : change.path}
          </Text>
        )}
        {change.op !== "drop" && change.severity !== undefined && <Grade severity={change.severity} theme={theme} regraded={change.op === "edit"} />}
      </View>
      {body && (
        <Text style={[styles.body, change.op === "edit" && styles.muted]} numberOfLines={open ? undefined : 3}>
          {body}
        </Text>
      )}
    </Pressable>
  );
}

function Grade({ severity, theme, regraded }: { severity: Severity; theme: PluginTheme; regraded: boolean }) {
  const label = `${regraded ? "→ " : ""}${severity ?? "note"}`;
  return <Pill theme={theme} color={severity ? severityColor(theme, severity) : theme.colors.foregroundMuted}>{label}</Pill>;
}

const joinWords = (words: string[]) => (words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);

function makeStyles(theme: PluginTheme, compact: boolean) {
  const { colors } = theme;
  return {
    card: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1, padding: compact ? 12 : 14, gap: 8, marginVertical: 6 },
    header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    title: { color: colors.foregroundMuted, fontSize: 12, flex: 1 },
    headline: { color: colors.foreground, fontSize: 14, lineHeight: 20 },
    change: { gap: 4 },
    changeHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexWrap: "wrap" as const },
    changeLabel: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const },
    id: { color: colors.foregroundMuted, fontSize: 12, fontFamily: MONO },
    path: { color: colors.foregroundMuted, fontSize: 12, fontFamily: MONO, flexShrink: 1 },
    body: { color: colors.foreground, fontSize: 13, lineHeight: 19, paddingLeft: 19 },
    muted: { color: colors.foregroundMuted, fontSize: 13 },
    refused: { color: colors.statusWarning, fontSize: 13 },
    link: { color: colors.accent, fontSize: 13 },
    footer: { flexDirection: "row" as const, justifyContent: "flex-end" as const },
    button: { paddingVertical: compact ? 10 : 6, paddingHorizontal: 12, borderRadius: 6, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface2 },
    buttonText: { color: colors.foreground, fontSize: 13 },
  };
}
