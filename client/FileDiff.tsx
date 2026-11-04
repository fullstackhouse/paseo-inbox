import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { anchors, parsePatch, type DiffLine } from "../shared/diff";
import type { PrFile } from "../shared/review";
import { CommentCard, type CommentChange, type DraftComment } from "./CommentCard";
import { MONO, tint } from "./ui";

const BIG = 300;
const STATUS: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" };

/** One file: a tappable header row, and when open its hunks with the drafted comments under their lines. */
export function FileDiff({ file, comments, theme, compact, open, onToggle, editable, onChange }: { file: PrFile; comments: DraftComment[]; theme: PluginTheme; compact: boolean; open: boolean; onToggle: () => void; editable: boolean; onChange: (commentId: string, change: CommentChange) => Promise<void> }) {
  const hunks = useMemo(() => (open ? parsePatch(file.patch) : []), [open, file.patch]);
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const [showBig, setShowBig] = useState(false);
  const live = comments.filter((comment) => comment.status !== "dropped").length;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const name = file.path.slice(dir.length);

  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${open ? "Collapse" : "Expand"} ${file.path}`} onPress={onToggle} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 12, width: 12 }}>{STATUS[file.status] ?? "M"}</Text>
        <Text style={{ flex: 1, fontSize: 14 }} numberOfLines={compact ? 2 : 1}>
          <Text style={{ color: theme.colors.foregroundMuted }}>{dir}</Text>
          <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{name}</Text>
        </Text>
        {live ? <Text style={{ color: theme.colors.accentForeground, backgroundColor: theme.colors.accent, borderRadius: 999, paddingHorizontal: 7, fontSize: 12, overflow: "hidden" }}>{live}</Text> : null}
        <Text style={{ fontFamily: MONO, fontSize: 12 }}>
          <Text style={{ color: theme.colors.statusSuccess }}>+{file.additions}</Text> <Text style={{ color: theme.colors.statusDanger }}>−{file.deletions}</Text>
        </Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? (
        !file.patch ? (
          <Text style={{ color: theme.colors.foregroundMuted, padding: 12, fontSize: 13 }}>No diff to show (binary, or too large for GitHub's API).</Text>
        ) : total > BIG && !showBig ? (
          <Pressable onPress={() => setShowBig(true)} style={{ padding: 12 }}>
            <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Show {total} diff lines</Text>
          </Pressable>
        ) : (
          <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
            {hunks.map((hunk, hunkIndex) => (
              <View key={hunkIndex}>
                <Text style={{ fontFamily: MONO, fontSize: 11, color: theme.colors.foregroundMuted, backgroundColor: tint(theme.colors.accent, 0.08), paddingHorizontal: 8, paddingVertical: 4 }} numberOfLines={1}>
                  {hunk.header}
                </Text>
                {hunk.lines.map((line, lineIndex) => (
                  <View key={lineIndex}>
                    <Line line={line} theme={theme} compact={compact} />
                    {comments
                      .filter((comment) => anchors(line, comment))
                      .map((comment) => (
                        <View key={comment.id} style={{ padding: 8, backgroundColor: theme.colors.surface0 }}>
                          <CommentCard comment={comment} theme={theme} editable={editable} onChange={(change) => onChange(comment.id, change)} />
                        </View>
                      ))}
                  </View>
                ))}
              </View>
            ))}
          </View>
        )
      ) : null}
    </View>
  );
}

function Line({ line, theme, compact }: { line: DiffLine; theme: PluginTheme; compact: boolean }) {
  const bg = line.kind === "add" ? tint(theme.colors.statusSuccess, 0.14) : line.kind === "del" ? tint(theme.colors.statusDanger, 0.14) : undefined;
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const number = { fontFamily: MONO, fontSize: 11, color: theme.colors.foregroundMuted, textAlign: "right" as const, width: 34, paddingRight: 6 };
  return (
    <View style={{ flexDirection: "row", backgroundColor: bg }}>
      {compact ? null : <Text style={number}>{line.old ?? ""}</Text>}
      <Text style={number}>{line.kind === "del" ? line.old : line.new}</Text>
      <Text style={{ fontFamily: MONO, fontSize: 12, color: theme.colors.foregroundMuted, width: 12 }}>{sign}</Text>
      <Text style={{ fontFamily: MONO, fontSize: 12, lineHeight: 18, color: theme.colors.foreground, flex: 1, paddingRight: 8 }}>{line.text || " "}</Text>
    </View>
  );
}
