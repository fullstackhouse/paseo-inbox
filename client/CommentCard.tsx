import type { PluginTheme } from "@getpaseo/plugin";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { ReviewDraft } from "../shared/review";
import { Markdown } from "./Markdown";
import { Chip, Pill, severityColor } from "./ui";

export type DraftComment = ReviewDraft["comments"][number];
export type CommentChange = { status: "kept" | "dropped" | "draft" } | { body: string };

/** One drafted inline comment with keep / edit / drop. A dropped comment stays visible, struck out, and can be restored. */
export function CommentCard({ comment, theme, editable, onChange, onOpenFile }: { comment: DraftComment; theme: PluginTheme; editable: boolean; onChange: (change: CommentChange) => Promise<void>; onOpenFile?: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [busy, setBusy] = useState(false);
  const dropped = comment.status === "dropped";
  const run = async (change: CommentChange) => {
    setBusy(true);
    try {
      await onChange(change);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.border, padding: 12, gap: 8, opacity: dropped ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <Pill theme={theme} color={severityColor(theme, comment.severity)}>{comment.severity}</Pill>
        <Text onPress={onOpenFile} style={{ color: onOpenFile ? theme.colors.accent : theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }} numberOfLines={1} ellipsizeMode="head">
          {comment.path}:{comment.line}
        </Text>
        {comment.status !== "draft" ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{comment.status}</Text> : null}
      </View>
      {editing ? (
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          autoFocus
          style={{ color: theme.colors.foreground, fontSize: 15, minHeight: 90, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, textAlignVertical: "top" }}
        />
      ) : (
        <View style={dropped ? { opacity: 0.8 } : undefined}>
          <Markdown text={comment.body} theme={theme} size={14} />
        </View>
      )}
      {editable ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
          {editing ? (
            <>
              <Chip theme={theme} active label="Save" disabled={busy} onPress={() => void run({ body: text })} />
              <Chip theme={theme} label="Cancel" onPress={() => { setText(comment.body); setEditing(false); }} />
            </>
          ) : dropped ? (
            <Chip theme={theme} label="Restore" disabled={busy} onPress={() => void run({ status: "draft" })} />
          ) : (
            <>
              {comment.status !== "kept" && comment.status !== "edited" ? <Chip theme={theme} label="Keep" disabled={busy} onPress={() => void run({ status: "kept" })} /> : null}
              <Chip theme={theme} label="Edit" onPress={() => setEditing(true)} />
              <Chip theme={theme} label="Drop" disabled={busy} onPress={() => void run({ status: "dropped" })} />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}
