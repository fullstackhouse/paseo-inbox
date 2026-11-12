import type { PluginTheme } from "@getpaseo/plugin";
import type { ReactNode } from "react";
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { PrUpstream } from "../shared/upstream";
import { Markdown } from "./Markdown";
import { useOpenUrl } from "./openUrl";
import { Chip, MONO } from "./ui";

const GROUPS = [
  { status: "failure", label: "Failing", symbol: "×", open: true },
  { status: "pending", label: "In progress", symbol: "◷", open: true },
  { status: "success", label: "Successful", symbol: "✓", open: false },
  { status: "skipped", label: "Skipped", symbol: "−", open: false },
] as const;

export function GitHubTab({
  data,
  error,
  loading,
  onRefresh,
  url,
  theme,
}: {
  data: PrUpstream | undefined;
  error: Error | null;
  loading: boolean;
  onRefresh: () => void;
  url: string;
  theme: PluginTheme;
}) {
  const openUrl = useOpenUrl();
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  const unresolved = data?.threads.filter((thread) => !thread.resolved) ?? [];
  const resolved = data?.threads.filter((thread) => thread.resolved) ?? [];
  const activity = data
    ? [
        ...data.comments.map((comment) => ({
          ...comment,
          key: `comment:${comment.id}`,
          action: "commented",
        })),
        ...data.reviews.map((review) => ({
          ...review,
          key: `review:${review.id}`,
          action: reviewAction(review.state),
        })),
      ].sort((a, b) => b.at.localeCompare(a.at))
    : [];

  return (
    <View style={{ gap: 20 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <Text style={{ ...muted, flexGrow: 1 }}>
          {data ? `Updated ${new Date(data.fetchedAt).toLocaleString()}` : "Published on GitHub"}
        </Text>
        <Chip
          theme={theme}
          label={loading ? "Refreshing…" : error ? "Retry" : "Refresh"}
          disabled={loading}
          onPress={onRefresh}
        />
        <Chip theme={theme} label="Open in GitHub ↗" onPress={() => openUrl(url)} />
      </View>
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
      {data ? (
        <>
          <View style={{ gap: 10 }}>
            <Heading theme={theme}>Checks</Heading>
            <Text style={muted}>
              For commit <Text style={{ fontFamily: MONO }}>{data.headSha.slice(0, 7)}</Text>
            </Text>
            {data.checks.length ? (
              GROUPS.map((group) => {
                const checks = data.checks.filter((check) => check.status === group.status);
                if (!checks.length) return null;
                const color =
                  group.status === "failure"
                    ? theme.colors.statusDanger
                    : group.status === "pending"
                      ? theme.colors.statusWarning
                      : group.status === "success"
                        ? theme.colors.statusSuccess
                        : theme.colors.foregroundMuted;
                return (
                  <Section
                    key={group.status}
                    title={`${group.label} checks · ${checks.length}`}
                    defaultOpen={group.open}
                    theme={theme}
                  >
                    {checks.map((check) => (
                      <View
                        key={check.id}
                        style={{
                          flexDirection: "row",
                          alignItems: "flex-start",
                          gap: 8,
                          paddingVertical: 5,
                        }}
                      >
                        <Text style={{ color, fontSize: 16 }}>{group.symbol}</Text>
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text
                            accessibilityRole={check.url ? "link" : undefined}
                            onPress={check.url ? () => openUrl(check.url!) : undefined}
                            style={{ color: theme.colors.foreground, fontSize: 14, flexShrink: 1 }}
                          >
                            {check.name}
                            {check.url ? " ↗" : ""}
                          </Text>
                          {check.workflow ? <Text style={muted}>{check.workflow}</Text> : null}
                        </View>
                      </View>
                    ))}
                  </Section>
                );
              })
            ) : (
              <Text style={muted}>No checks reported for this commit.</Text>
            )}
          </View>
          <View style={{ gap: 10 }}>
            <Heading theme={theme}>Review threads · {unresolved.length} unresolved</Heading>
            {unresolved.map((thread) => (
              <Thread key={thread.id} thread={thread} theme={theme} />
            ))}
            {!unresolved.length ? <Text style={muted}>No unresolved review threads.</Text> : null}
            {resolved.length ? (
              <Section
                title={`Resolved threads · ${resolved.length}`}
                defaultOpen={false}
                theme={theme}
              >
                {resolved.map((thread) => (
                  <Thread key={thread.id} thread={thread} theme={theme} />
                ))}
              </Section>
            ) : null}
          </View>
          <View style={{ gap: 10 }}>
            <Heading theme={theme}>Activity · {activity.length}</Heading>
            <Text style={muted}>Published reviews and comments, newest first.</Text>
            {activity.length ? (
              activity.map((entry) => (
                <View
                  key={entry.key}
                  style={{
                    gap: 10,
                    padding: 14,
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: 10,
                  }}
                >
                  <EntryHeader
                    author={entry.author}
                    action={entry.action}
                    at={entry.at}
                    url={entry.url}
                    theme={theme}
                  />
                  {entry.body.trim() ? (
                    <Markdown text={entry.body} theme={theme} size={14} />
                  ) : null}
                </View>
              ))
            ) : (
              <Text style={muted}>No published reviews or comments yet.</Text>
            )}
          </View>
        </>
      ) : null}
    </View>
  );
}

function reviewAction(state: string) {
  switch (state.toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "requested changes";
    case "DISMISSED":
      return "review dismissed";
    default:
      return "reviewed";
  }
}

function Heading({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text
      accessibilityRole="header"
      style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}
    >
      {children}
    </Text>
  );
}

function Section({
  title,
  defaultOpen,
  theme,
  children,
}: {
  title: string;
  defaultOpen: boolean;
  theme: PluginTheme;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={{ gap: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ flexDirection: "row", gap: 6, paddingVertical: 6 }}
      >
        <Text style={{ color: theme.colors.foregroundMuted }}>{open ? "▾" : "▸"}</Text>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, flex: 1 }}>{title}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function EntryHeader({
  author,
  action,
  at,
  url,
  theme,
}: {
  author: string;
  action: string;
  at: string;
  url: string;
  theme: PluginTheme;
}) {
  const openUrl = useOpenUrl();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "baseline" }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600" }}>
        {author || "Deleted user"}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flexGrow: 1 }}>
        {action}
      </Text>
      <Text
        accessibilityRole="link"
        onPress={() => openUrl(url)}
        style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}
      >
        {new Date(at).toLocaleString()} ↗
      </Text>
    </View>
  );
}

function Thread({ thread, theme }: { thread: PrUpstream["threads"][number]; theme: PluginTheme }) {
  return (
    <View
      style={{
        padding: 14,
        gap: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 10,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontFamily: MONO, fontSize: 12 }}>
        {thread.path}
        {thread.line ? `:${thread.line}` : ""}
        {thread.outdated ? " · outdated" : ""}
      </Text>
      {thread.comments.map((comment, index) => (
        <View
          key={comment.id}
          style={{
            gap: 8,
            ...(index
              ? { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 12 }
              : {}),
          }}
        >
          <EntryHeader {...comment} action={index ? "replied" : "commented"} theme={theme} />
          <Markdown text={comment.body} theme={theme} size={14} empty="No comment body." />
        </View>
      ))}
    </View>
  );
}
