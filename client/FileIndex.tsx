import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { fileTree } from "../shared/filetree";
import type { PrFile } from "../shared/review";
import { Chip, MONO, tint } from "./ui";

export type IndexFilter = "all" | "unviewed" | "commented";

const STATUS: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M", unchanged: "·" };

/**
 * The PR's files as a tree: status, comment count, viewed tick and size per file. Tapping a file
 * jumps to its diff; `current` is the file on screen. The filter only narrows this list.
 */
export function FileIndex({
  files,
  theme,
  current,
  viewed,
  comments,
  onJump,
  onViewed,
}: {
  files: readonly PrFile[];
  theme: PluginTheme;
  current: string | null;
  viewed: (file: PrFile) => boolean;
  comments: (path: string) => number;
  onJump: (path: string) => void;
  /** Absent while there's no draft to keep viewed marks on. */
  onViewed?: (file: PrFile, value: boolean) => void;
}) {
  const [filter, setFilter] = useState<IndexFilter>("all");
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const shown = files.filter((file) => (filter === "unviewed" ? !viewed(file) : filter === "commented" ? comments(file.path) > 0 : true));
  const rows = fileTree(shown.map((file) => file.path));
  const muted = theme.colors.foregroundMuted;
  const small = { paddingVertical: 3, paddingHorizontal: 8 };

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 4, flexWrap: "wrap" }}>
        <Chip theme={theme} label="All" active={filter === "all"} onPress={() => setFilter("all")} style={small} textStyle={{ fontSize: 12 }} />
        <Chip theme={theme} label="Not viewed" active={filter === "unviewed"} onPress={() => setFilter("unviewed")} style={small} textStyle={{ fontSize: 12 }} />
        <Chip theme={theme} label="Commented" active={filter === "commented"} onPress={() => setFilter("commented")} style={small} textStyle={{ fontSize: 12 }} />
      </View>
      {rows.length ? null : <Text style={{ color: muted, fontSize: 12, paddingVertical: 4 }}>{filter === "unviewed" ? "Every file is viewed." : "No files with comments."}</Text>}
      <View>
        {rows.map((row) => {
          const indent = 6 + row.depth * 12;
          if (row.kind === "dir")
            return (
              <Text key={row.key} numberOfLines={1} style={{ color: muted, fontSize: 12, paddingLeft: indent, paddingVertical: 3 }}>
                {row.name}/
              </Text>
            );
          const file = byPath.get(row.path)!;
          const isViewed = viewed(file);
          const count = comments(row.path);
          const here = row.path === current;
          return (
            <Pressable
              key={row.key}
              accessibilityRole="button"
              accessibilityLabel={`Go to ${row.path}`}
              onPress={() => onJump(row.path)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: indent, paddingRight: 6, paddingVertical: 3, borderRadius: 6, backgroundColor: here ? tint(theme.colors.accent, 0.18) : undefined }}
            >
              <Text style={{ color: muted, fontFamily: MONO, fontSize: 11, width: 10 }}>{STATUS[file.status] ?? "M"}</Text>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: isViewed ? muted : theme.colors.foreground, fontWeight: here ? "600" : "400" }}>
                {row.name}
              </Text>
              {count ? <Text style={{ color: theme.colors.accentForeground, backgroundColor: theme.colors.accent, borderRadius: 999, paddingHorizontal: 6, fontSize: 11, overflow: "hidden" }}>{count}</Text> : null}
              <Text style={{ fontFamily: MONO, fontSize: 11 }}>
                <Text style={{ color: theme.colors.statusSuccess }}>+{file.additions}</Text> <Text style={{ color: theme.colors.statusDanger }}>−{file.deletions}</Text>
              </Text>
              {onViewed ? (
                <Text
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isViewed }}
                  accessibilityLabel={`Viewed ${row.path}`}
                  onPress={() => onViewed(file, !isViewed)}
                  style={{ fontSize: 14, color: isViewed ? theme.colors.statusSuccess : muted, paddingHorizontal: 2 }}
                >
                  {isViewed ? "☑" : "☐"}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
