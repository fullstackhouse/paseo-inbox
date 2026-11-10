import { Text } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Markdown as SharedMarkdown, type MarkdownProps } from "@getpaseo/plugin/client/ui";

export function Markdown({
  text,
  theme,
  size = 15,
  afterBlock,
  empty = "No description.",
}: {
  text: string;
  theme: PluginTheme;
  size?: number;
  afterBlock?: MarkdownProps["afterBlock"];
  empty?: string;
}) {
  if (!text.trim())
    return <Text style={{ color: theme.colors.foregroundMuted, fontSize: size }}>{empty}</Text>;
  if (
    afterBlock &&
    !(
      "supportsBlockAnnotations" in SharedMarkdown &&
      SharedMarkdown.supportsBlockAnnotations === true
    )
  ) {
    return (
      <Text style={{ color: theme.colors.foregroundMuted }}>
        Update Paseo to view this document with inline comments. You can read the file and comments
        in Diff.
      </Text>
    );
  }
  return (
    <SharedMarkdown compact={size < 15} afterBlock={afterBlock}>
      {text}
    </SharedMarkdown>
  );
}
