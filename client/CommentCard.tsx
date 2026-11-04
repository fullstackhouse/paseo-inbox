import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { SEVERITIES, type CommentChange, type Placement, type Severity, type StoredComment } from "../shared/review";
import { Markdown } from "./Markdown";
import { Chip, Pill, severityColor } from "./ui";

export type { CommentChange };

const PLACEMENT_NOTE: Record<Placement, string | null> = {
  inline: null,
  file: "on the file · posts in the review body",
  outside: "not on a changed line · posts in the review body",
};

/** Severity picker: the three grades plus "note" (ungraded). */
export function SeverityPicker({ theme, value, onChange }: { theme: PluginTheme; value: Severity; onChange: (severity: Severity) => void }) {
  return (
    <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
      {[...SEVERITIES, null].map((severity) => (
        <Chip key={severity ?? "note"} theme={theme} label={severity ?? "note"} active={value === severity} onPress={() => onChange(severity)} style={{ paddingVertical: 4, paddingHorizontal: 10 }} textStyle={{ fontSize: 12 }} />
      ))}
    </View>
  );
}

/**
 * One review comment: grade, place, body, and the human's controls. Reviewer comments can be kept,
 * edited, regraded, dropped and restored; the human's own can be edited and deleted.
 */
export function CommentCard({
  comment,
  theme,
  editable,
  where = "inline",
  onChange,
  onDelete,
  onDiscuss,
  onOpenFile,
}: {
  comment: StoredComment;
  theme: PluginTheme;
  editable: boolean;
  where?: Placement;
  onChange: (change: CommentChange) => Promise<void>;
  onDelete?: () => Promise<void>;
  onDiscuss?: () => void;
  onOpenFile?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const dropped = comment.status === "dropped";
  const mine = comment.author === "human";
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  const small = { paddingVertical: 4, paddingHorizontal: 10 };
  const smallText = { fontSize: 12 };
  const note = PLACEMENT_NOTE[where];
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderRadius: 10, borderWidth: 1, borderColor: mine ? theme.colors.accent : theme.colors.border, padding: 12, gap: 8, opacity: dropped ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill theme={theme} color={comment.severity ? severityColor(theme, comment.severity) : theme.colors.foregroundMuted}>{comment.severity ?? "note"}</Pill>
        {mine ? <Pill theme={theme} color={theme.colors.accent}>yours</Pill> : null}
        <Text onPress={onOpenFile} style={{ color: onOpenFile ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }} numberOfLines={1} ellipsizeMode="head">
          {comment.path}
          {comment.line ? `:${comment.line}` : ""}
        </Text>
        {comment.status !== "draft" && !mine ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{comment.status}</Text> : null}
      </View>
      {note ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{note}</Text> : null}
      {editing ? (
        <>
          <TextInput
            value={text}
            onChangeText={setText}
            multiline
            autoFocus
            style={{ color: theme.colors.foreground, fontSize: 15, minHeight: 90, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, textAlignVertical: "top" }}
          />
          <SeverityPicker theme={theme} value={comment.severity} onChange={(severity) => void run(() => onChange({ severity }))} />
        </>
      ) : (
        <Markdown text={comment.body} theme={theme} size={14} />
      )}
      {editable ? (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          {editing ? (
            <>
              <Chip theme={theme} active label="Save" disabled={busy} style={small} textStyle={smallText} onPress={() => void run(() => onChange({ body: text }))} />
              <Chip
                theme={theme}
                label="Cancel"
                style={small}
                textStyle={smallText}
                onPress={() => {
                  setText(comment.body);
                  setEditing(false);
                }}
              />
            </>
          ) : dropped ? (
            <Chip theme={theme} label="Restore" disabled={busy} style={small} textStyle={smallText} onPress={() => void run(() => onChange({ status: "draft" }))} />
          ) : (
            <>
              {!mine && comment.status === "draft" ? <Chip theme={theme} label="Keep" disabled={busy} style={small} textStyle={smallText} onPress={() => void run(() => onChange({ status: "kept" }))} /> : null}
              <Chip theme={theme} label="Edit" style={small} textStyle={smallText} onPress={() => setEditing(true)} />
              {mine && onDelete ? (
                <Chip theme={theme} label="Delete" disabled={busy} style={small} textStyle={smallText} onPress={() => void run(onDelete)} />
              ) : (
                <Chip theme={theme} label="Drop" disabled={busy} style={small} textStyle={smallText} onPress={() => void run(() => onChange({ status: "dropped" }))} />
              )}
              {onDiscuss && !mine ? <Chip theme={theme} label="Ask about this" style={small} textStyle={smallText} onPress={onDiscuss} /> : null}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** Write a new comment on a line (or the whole file), or put a question to the reviewer instead. */
export function Composer({ theme, target, onAdd, onAsk, onCancel }: { theme: PluginTheme; target: string; onAdd: (body: string, severity: Severity) => Promise<void>; onAsk?: (question: string) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<Severity>(null);
  const [busy, setBusy] = useState(false);
  const small = { paddingVertical: 4, paddingHorizontal: 10 };
  const add = async () => {
    setBusy(true);
    try {
      await onAdd(text.trim(), severity);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.accent, padding: 12, gap: 8 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{target}</Text>
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        autoFocus
        placeholder="Your comment, or a question for the reviewer"
        placeholderTextColor={theme.colors.foregroundMuted}
        style={{ color: theme.colors.foreground, fontSize: 15, minHeight: 80, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, textAlignVertical: "top" }}
      />
      <SeverityPicker theme={theme} value={severity} onChange={setSeverity} />
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Chip theme={theme} active label="Add comment" disabled={busy || !text.trim()} style={small} onPress={() => void add()} />
        {onAsk ? <Chip theme={theme} label="Ask the reviewer" disabled={!text.trim()} style={small} onPress={() => onAsk(text.trim())} /> : null}
        <Chip theme={theme} label="Cancel" style={small} onPress={onCancel} />
      </View>
    </View>
  );
}
