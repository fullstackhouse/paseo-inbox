import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { previewPr, type PrDetails } from "../shared/review";
import { FileDiff, type DiffActions } from "./FileDiff";
import { Markdown } from "./Markdown";
import { useOpenUrl } from "./openUrl";
import { ago, Chip, MONO } from "./ui";

type Preview = { repo: string; number: number; url: string; details: PrDetails };
type Tab = "description" | "files";

// Nothing to edit or ask about without a review run: lines aren't tappable and no composer opens.
const READ_ONLY: DiffActions = {
  editable: false,
  onChange: async () => undefined,
  onDelete: async () => undefined,
  onAdd: async () => undefined,
  onAsk: async () => false,
};

/**
 * A PR opened by link that has no review yet: its description and diff, read-only, with Start review
 * and GitHub. Starting a review swaps this for the full review screen.
 */
export function PrPreview(props: {
  theme: PluginTheme;
  compact: boolean;
  prRef: string;
  prLabel: string;
  starting: boolean;
  error: string | null;
  onStart(): void;
}) {
  const { theme, compact, prRef, prLabel } = props;
  const load = useRpc(previewPr);
  const openUrl = useOpenUrl();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("description");
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    setPreview(null);
    setLoadError(null);
    void load({ ref: prRef })
      .then((value) => live && setPreview(value))
      .catch((caught) => live && setLoadError(caught instanceof Error ? caught.message : String(caught)));
    return () => {
      live = false;
    };
  }, [load, prRef]);

  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const pad = compact ? 14 : 24;
  const width = { width: "100%" as const, maxWidth: 980, alignSelf: "center" as const };
  const details = preview?.details;
  const files = details?.files ?? [];
  const toggle = (path: string) =>
    setOpenFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView stickyHeaderIndices={[1]} contentContainerStyle={{ paddingBottom: 24 }}>
        <View style={{ paddingHorizontal: pad, paddingTop: pad, paddingBottom: 10, gap: 8, ...width }}>
          <Text style={muted}>{prLabel} · no review yet</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: compact ? 18 : 22, fontWeight: "700", lineHeight: compact ? 24 : 28 }}>
            {details?.title || prLabel}
          </Text>
          {details ? (
            <Text style={muted}>
              {details.author} · {details.headRef} → {details.baseRef} · <Text style={{ fontFamily: MONO }}>{details.headSha.slice(0, 7)}</Text> ·{" "}
              <Text style={{ color: theme.colors.statusSuccess }}>+{details.additions}</Text>{" "}
              <Text style={{ color: theme.colors.statusDanger }}>−{details.deletions}</Text> · {details.changedFiles} files · opened {ago(details.createdAt)} ago
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Chip theme={theme} active label={props.starting ? "Starting…" : "Start review"} disabled={props.starting} onPress={props.onStart} />
            {preview ? <Chip theme={theme} label="GitHub ↗" onPress={() => openUrl(preview.url)} /> : null}
          </View>
          {props.error ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{props.error}</Text> : null}
        </View>

        <View style={{ backgroundColor: theme.colors.surface0, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}>
          <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: pad, paddingVertical: 8, justifyContent: compact ? "flex-start" : "center" }}>
            <Chip theme={theme} label="Description" active={tab === "description"} onPress={() => setTab("description")} />
            <Chip theme={theme} label={details ? `Files ${files.length}` : "Files"} active={tab === "files"} onPress={() => setTab("files")} />
          </View>
        </View>

        <View style={{ paddingHorizontal: pad, paddingTop: 14, gap: 12, ...width }}>
          {loadError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{loadError}</Text> : null}
          {!details && !loadError ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : null}
          {details && tab === "description" ? <Markdown text={details.body} theme={theme} /> : null}
          {details && tab === "files" ? (
            <>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                <Chip theme={theme} label="Expand all" onPress={() => setOpenFiles(new Set(files.map((file) => file.path)))} />
                <Chip theme={theme} label="Collapse all" onPress={() => setOpenFiles(new Set())} />
              </View>
              {files.map((file) => (
                <FileDiff
                  key={file.path}
                  file={file}
                  comments={[]}
                  threads={details.threads.filter((thread) => thread.path === file.path)}
                  theme={theme}
                  compact={compact}
                  open={openFiles.has(file.path)}
                  onToggle={() => toggle(file.path)}
                  actions={READ_ONLY}
                />
              ))}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
