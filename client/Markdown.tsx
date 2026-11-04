import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Linking, Text, View } from "react-native";
import { parseMarkdown, type Inline } from "../shared/markdown";
import { MONO, tint } from "./ui";

function Inlines({ inlines, theme, size }: { inlines: Inline[]; theme: PluginTheme; size: number }) {
  return (
    <>
      {inlines.map((inline, index) => {
        switch (inline.kind) {
          case "bold":
            return (
              <Text key={index} style={{ fontWeight: "700" }}>
                <Inlines inlines={inline.inlines} theme={theme} size={size} />
              </Text>
            );
          case "italic":
            return <Text key={index} style={{ fontStyle: "italic" }}>{inline.text}</Text>;
          case "code":
            return <Text key={index} style={{ fontFamily: MONO, fontSize: size - 1, backgroundColor: theme.colors.surface2 }}> {inline.text} </Text>;
          case "link":
            return <Text key={index} style={{ color: theme.colors.accent, textDecorationLine: "underline" }} onPress={() => void Linking.openURL(inline.url)}>{inline.text}</Text>;
          default:
            return <Text key={index}>{inline.text}</Text>;
        }
      })}
    </>
  );
}

/** Markdown for PR descriptions and review text, drawn with native Text. */
export function Markdown({ text, theme, size = 15 }: { text: string; theme: PluginTheme; size?: number }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const base = { color: theme.colors.foreground, fontSize: size, lineHeight: Math.round(size * 1.5) };
  if (!blocks.length) return <Text style={{ ...base, color: theme.colors.foregroundMuted }}>No description.</Text>;
  return (
    <View style={{ gap: 10 }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <Text key={index} style={{ ...base, fontSize: block.level <= 2 ? size + 2 : size, fontWeight: "700", marginTop: index ? 6 : 0 }}>
                <Inlines inlines={block.inlines} theme={theme} size={size} />
              </Text>
            );
          case "list":
            return (
              <View key={index} style={{ gap: 4 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={{ flexDirection: "row", gap: 8 }}>
                    <Text style={{ ...base, color: theme.colors.foregroundMuted, minWidth: 14 }}>{block.ordered ? `${itemIndex + 1}.` : "•"}</Text>
                    <Text style={{ ...base, flex: 1 }}>
                      <Inlines inlines={item} theme={theme} size={size} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "code":
            return (
              <Text key={index} style={{ fontFamily: MONO, fontSize: size - 2, lineHeight: Math.round(size * 1.35), color: theme.colors.foreground, backgroundColor: theme.colors.surface2, padding: 10, borderRadius: 6 }}>
                {block.text}
              </Text>
            );
          case "quote":
            return (
              <Text key={index} style={{ ...base, color: theme.colors.foregroundMuted, borderLeftWidth: 3, borderLeftColor: tint(theme.colors.foregroundMuted, 0.4), paddingLeft: 10 }}>
                <Inlines inlines={block.inlines} theme={theme} size={size} />
              </Text>
            );
          case "rule":
            return <View key={index} style={{ height: 1, backgroundColor: theme.colors.border }} />;
          default:
            return (
              <Text key={index} style={base}>
                <Inlines inlines={block.inlines} theme={theme} size={size} />
              </Text>
            );
        }
      })}
    </View>
  );
}
