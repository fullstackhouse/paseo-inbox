import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { anchors, parsePatch, type DiffLine } from "../shared/diff";
import type { PrFile, Severity, StoredComment } from "../shared/review";
import { CommentCard, Composer, type CommentChange } from "./CommentCard";
import { MONO, tint } from "./ui";

const BIG = 300;
// Long tokens (URLs, hashes) wrap anywhere instead of running off the line; native Text already does.
const BREAK = (Platform.OS === "web" ? { overflowWrap: "anywhere" } : {}) as object;
const STATUS: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" };

export interface DiffActions {
  editable: boolean;
  onChange: (commentId: string, change: CommentChange) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onAdd: (comment: { path: string; line: number | null; side: "LEFT" | "RIGHT"; severity: Severity; body: string }) => Promise<void>;
  /** Sends `question` to the reviewer agent, quoting what it's `about`. */
  onAsk: (question: string, about: string) => void;
}

type Target = { line: number | null; side: "LEFT" | "RIGHT"; text?: string };

/**
 * One file: a tappable header, and when open its hunks with the comments under their lines. Comments
 * on the whole file sit at the top, comments off the diff at the bottom. Tapping a line opens a
 * composer under it.
 */
export function FileDiff({ file, comments, theme, compact, open, onToggle, actions }: { file: PrFile; comments: StoredComment[]; theme: PluginTheme; compact: boolean; open: boolean; onToggle: () => void; actions: DiffActions }) {
  const hunks = useMemo(() => (open ? parsePatch(file.patch) : []), [open, file.patch]);
  const total = hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const [showBig, setShowBig] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const live = comments.filter((comment) => comment.status !== "dropped").length;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const name = file.path.slice(dir.length);
  const on = (line: DiffLine, comment: StoredComment) => comment.line !== null && anchors(line, { line: comment.line, side: comment.side });

  const anchored = new Set(hunks.flatMap((hunk) => hunk.lines.flatMap((line) => comments.filter((comment) => on(line, comment)).map((comment) => comment.id))));
  const fileLevel = comments.filter((comment) => comment.line === null);
  const outside = open && file.patch ? comments.filter((comment) => comment.line !== null && !anchored.has(comment.id)) : [];
  // A big file folds only when nothing in it is commented: comments are never hidden behind a click.
  const diffShown = Boolean(file.patch) && (total <= BIG || showBig || comments.length > 0);

  const card = (comment: StoredComment, where: "inline" | "file" | "outside") => (
    <CommentCard
      key={comment.id}
      comment={comment}
      theme={theme}
      editable={actions.editable}
      where={where}
      onChange={(change) => actions.onChange(comment.id, change)}
      onDelete={() => actions.onDelete(comment.id)}
      onDiscuss={() => actions.onAsk("", `your comment on ${comment.path}${comment.line ? `:${comment.line}` : ""} (${comment.id}): "${comment.body}"`)}
    />
  );
  const composer = (at: Target) => (
    <Composer
      theme={theme}
      target={at.line ? `${file.path}:${at.line}${at.side === "LEFT" ? " (old side)" : ""}` : `${file.path} (whole file)`}
      onCancel={() => setTarget(null)}
      onAdd={async (body, severity) => {
        await actions.onAdd({ path: file.path, line: at.line, side: at.side, severity, body });
        setTarget(null);
      }}
      onAsk={(question) => {
        actions.onAsk(question, at.line ? `${file.path}:${at.line}${at.text !== undefined ? `, the line \`${at.text.trim()}\`` : ""}` : `the file ${file.path}`);
        setTarget(null);
      }}
    />
  );

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
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          {fileLevel.length || actions.editable ? (
            <View style={{ padding: 8, gap: 8, backgroundColor: theme.colors.surface0 }}>
              {fileLevel.map((comment) => card(comment, "file"))}
              {actions.editable && target?.line === null ? composer(target) : null}
              {actions.editable && !(target && target.line === null) ? (
                <Text onPress={() => setTarget({ line: null, side: "RIGHT" })} style={{ color: theme.colors.accent, fontSize: 12 }}>
                  + Comment on the whole file{diffShown ? " · or tap a line" : ""}
                </Text>
              ) : null}
            </View>
          ) : null}
          {!file.patch ? (
            <Text style={{ color: theme.colors.foregroundMuted, padding: 12, fontSize: 13 }}>No diff to show (binary, or too large for GitHub's API).</Text>
          ) : !diffShown ? (
            <Pressable onPress={() => setShowBig(true)} style={{ padding: 12 }}>
              <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Show {total} diff lines</Text>
            </Pressable>
          ) : (
            hunks.map((hunk, hunkIndex) => (
              <View key={hunkIndex}>
                <Text style={{ fontFamily: MONO, fontSize: 11, color: theme.colors.foregroundMuted, backgroundColor: tint(theme.colors.accent, 0.08), paddingHorizontal: 8, paddingVertical: 4 }} numberOfLines={1}>
                  {hunk.header}
                </Text>
                {hunk.lines.map((line, lineIndex) => {
                  const side = line.kind === "del" ? ("LEFT" as const) : ("RIGHT" as const);
                  const number = (side === "LEFT" ? line.old : line.new) ?? null;
                  const here = Boolean(target && target.line !== null && target.line === number && target.side === side);
                  return (
                    <View key={lineIndex}>
                      <Line line={line} theme={theme} compact={compact} active={here} onPress={actions.editable && number ? () => setTarget(here ? null : { line: number, side, text: line.text }) : undefined} />
                      {comments
                        .filter((comment) => on(line, comment))
                        .map((comment) => (
                          <View key={comment.id} style={{ padding: 8, backgroundColor: theme.colors.surface0 }}>
                            {card(comment, "inline")}
                          </View>
                        ))}
                      {here && target ? <View style={{ padding: 8, backgroundColor: theme.colors.surface0 }}>{composer(target)}</View> : null}
                    </View>
                  );
                })}
              </View>
            ))
          )}
          {outside.length ? <View style={{ padding: 8, gap: 8, backgroundColor: theme.colors.surface0 }}>{outside.map((comment) => card(comment, "outside"))}</View> : null}
        </View>
      ) : null}
    </View>
  );
}

function Line({ line, theme, compact, onPress, active }: { line: DiffLine; theme: PluginTheme; compact: boolean; onPress?: () => void; active: boolean }) {
  const bg = active ? tint(theme.colors.accent, 0.2) : line.kind === "add" ? tint(theme.colors.statusSuccess, 0.14) : line.kind === "del" ? tint(theme.colors.statusDanger, 0.14) : undefined;
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  const number = { fontFamily: MONO, fontSize: 11, color: theme.colors.foregroundMuted, textAlign: "right" as const, width: 34, paddingRight: 6 };
  return (
    <Pressable onPress={onPress} disabled={!onPress} accessibilityLabel={onPress ? `Comment on line ${line.new ?? line.old}` : undefined} style={{ flexDirection: "row", backgroundColor: bg }}>
      {compact ? null : <Text style={number}>{line.old ?? ""}</Text>}
      <Text style={number}>{line.kind === "del" ? line.old : line.new}</Text>
      <Text style={{ fontFamily: MONO, fontSize: 12, color: theme.colors.foregroundMuted, width: 12 }}>{sign}</Text>
      <Text style={[{ fontFamily: MONO, fontSize: 12, lineHeight: 18, color: theme.colors.foreground, flex: 1, minWidth: 0, paddingRight: 8 }, BREAK]}>{line.text || " "}</Text>
    </Pressable>
  );
}
