import type { PluginTheme } from "@getpaseo/plugin";
import { PullRequestPanel } from "@getpaseo/plugin/client/ui";
import { ActivityIndicator, Text, View } from "react-native";
import type { Pr } from "../shared/inbox";
import type { PrUpstream } from "../shared/upstream";
import { pullRequestPanelData } from "./pullRequestPanelData";
import { Chip } from "./ui";

export function GitHubTab({
  data,
  error,
  loading,
  onRefresh,
  pr,
  theme,
}: {
  data: PrUpstream | undefined;
  error: Error | null;
  loading: boolean;
  onRefresh: () => void;
  pr: Pr;
  theme: PluginTheme;
}) {
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  if (typeof PullRequestPanel === "undefined") {
    return (
      <Text style={muted}>
        Update Paseo to view GitHub checks and activity in the shared pull request panel.
      </Text>
    );
  }
  return (
    <View style={{ gap: 12 }}>
      {error ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.statusDanger, fontSize: 14 }}>
          Could not refresh GitHub data. {error.message}
          {data ? " Showing the last successful update." : ""}
        </Text>
      ) : null}
      {!data && loading ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <ActivityIndicator color={theme.colors.foregroundMuted} />
          <Text style={muted}>Loading GitHub checks and activity…</Text>
        </View>
      ) : null}
      {!data && error ? (
        <Chip theme={theme} label="Retry" disabled={loading} onPress={onRefresh} />
      ) : null}
      {data ? (
        <>
          <Text style={muted}>
            For commit {data.headSha.slice(0, 7)} · Updated{" "}
            {new Date(data.fetchedAt).toLocaleString()}
          </Text>
          <PullRequestPanel
            data={pullRequestPanelData(pr, data)}
            scrollable={false}
            showHeader={false}
            onRefresh={onRefresh}
            isRefreshing={loading}
          />
        </>
      ) : null}
    </View>
  );
}
