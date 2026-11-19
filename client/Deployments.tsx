import type { PluginTheme } from "@getpaseo/plugin";
import { Pressable, Text, View } from "react-native";
import type { DeployEntry } from "../shared/upstream";
import { tint } from "./ui";

const LOOK: Record<DeployEntry["state"], { mark: string; word: string }> = {
  ready: { mark: "●", word: "Ready" },
  deploying: { mark: "◌", word: "Deploying" },
  failed: { mark: "✕", word: "Failed" },
  inactive: { mark: "○", word: "Inactive" },
};

/** Preview deployments as tappable chips (`● Ready · pr-12.example.dev`); nothing when there are none. */
export function Deployments({ theme, entries, onOpen }: { theme: PluginTheme; entries: DeployEntry[] | undefined; onOpen(url: string): void }) {
  if (!entries?.length) return null;
  const color = (state: DeployEntry["state"]) =>
    state === "ready" ? theme.colors.statusSuccess : state === "deploying" ? theme.colors.statusWarning : state === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {entries.map((entry) => {
        const { mark, word } = LOOK[entry.state];
        const link = entry.link;
        return (
          <Pressable
            key={`${entry.state}:${entry.label}`}
            accessibilityRole="link"
            accessibilityLabel={`${word} deployment ${entry.label}`}
            disabled={!link}
            onPress={() => link && onOpen(link)}
            hitSlop={4}
            style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: tint(color(entry.state), 0.12) }}
          >
            <Text style={{ color: color(entry.state), fontSize: 12, fontWeight: "600" }}>
              {mark} {word}
            </Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12, flexShrink: 1 }}>
              {entry.label}
              {link ? " ↗" : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
