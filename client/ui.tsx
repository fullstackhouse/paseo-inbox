import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { Severity } from "../shared/review";

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

/** A theme color at `alpha`; hex (#rgb/#rrggbb) and rgb()/rgba() inputs, anything else unchanged. */
export function tint(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)/.exec(color);
  return rgb ? `rgba(${rgb[1]!.trim()}, ${rgb[2]!.trim()}, ${rgb[3]!.trim()}, ${alpha})` : color;
}

export const verdictColor = (theme: PluginTheme, verdict: string) =>
  verdict === "approve" ? theme.colors.statusSuccess : verdict === "request-changes" ? theme.colors.statusDanger : theme.colors.statusWarning;

export const severityColor = (theme: PluginTheme, severity: NonNullable<Severity>) =>
  severity === "blocker" ? theme.colors.statusDanger : severity === "minor" ? theme.colors.statusWarning : theme.colors.foregroundMuted;

export function Pill({ theme, color, children }: { theme: PluginTheme; color: string; children: ReactNode }) {
  return (
    <Text style={{ color, backgroundColor: tint(color, 0.14), borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontSize: 12, fontWeight: "600", overflow: "hidden" }}>
      {children}
    </Text>
  );
}

export function Chip({ theme, label, onPress, active, style, textStyle, accessibilityLabel, disabled }: { theme: PluginTheme; label: string; onPress: () => void; active?: boolean; style?: StyleProp<ViewStyle>; textStyle?: StyleProp<TextStyle>; accessibilityLabel?: string; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={[{ paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: active ? theme.colors.accent : theme.colors.surface2, opacity: disabled ? 0.5 : 1 }, style]}
    >
      <Text style={[{ color: active ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 13 }, textStyle]}>{label}</Text>
    </Pressable>
  );
}

export function ago(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
