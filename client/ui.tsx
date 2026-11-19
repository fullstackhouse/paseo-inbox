import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { agoText } from "../shared/ago";
import { prState, type PrDetails, type Severity } from "../shared/review";

export { ago, agoText } from "../shared/ago";

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

/** Web-only `position: sticky` (react-native-web passes it through; React Native's types don't know it). */
export const STICKY = (top: number) => ({ position: "sticky", top, zIndex: 2 }) as object;

export const verdictColor = (theme: PluginTheme, verdict: string) =>
  verdict === "approve" ? theme.colors.statusSuccess : verdict === "request-changes" ? theme.colors.statusDanger : theme.colors.statusWarning;

export const severityColor = (theme: PluginTheme, severity: NonNullable<Severity>) =>
  severity === "blocker" ? theme.colors.statusDanger : severity === "minor" ? theme.colors.statusWarning : theme.colors.foregroundMuted;

/** `outlined` drops the tinted fill: a muted color on its own tint falls under 4.5:1 on light themes. */
export function Pill({ theme, color, outlined, children }: { theme: PluginTheme; color: string; outlined?: boolean; children: ReactNode }) {
  const fill = outlined ? { borderWidth: 1, borderColor: tint(color, 0.45), paddingVertical: 1, paddingHorizontal: 7 } : { backgroundColor: tint(color, 0.14) };
  return (
    <Text style={{ color, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, fontSize: 12, fontWeight: "600", overflow: "hidden", ...fill }}>
      {children}
    </Text>
  );
}

/** "merged 22h ago" / "closed 3d ago"; nothing while the PR is open. */
export function PrStatePill({ theme, details }: { theme: PluginTheme; details: Pick<PrDetails, "createdAt" | "closedAt" | "mergedAt"> }) {
  const { state, at } = prState(details);
  if (state === "open") return null;
  return <Pill theme={theme} color={state === "merged" ? theme.colors.statusSuccess : theme.colors.statusDanger}>{state} {agoText(at)}</Pill>;
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

