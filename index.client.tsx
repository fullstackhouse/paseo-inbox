import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { INBOX_SCREEN, InboxScreen } from "./client/InboxScreen";
import { setOpenScreen } from "./client/nav";
import { REVIEW_CARD, ReviewCard, ReviewCardSchema } from "./client/ReviewCard";
import { InboxSettings } from "./client/SettingsScreen";
import { REVIEW_SCREEN, ReviewScreen } from "./client/ReviewScreen";
import { useInbox } from "./client/useInbox";
import { needsDecisionCount } from "./shared/inbox";

/** The FSH host's needs-input orange; older hosts only have the status warning. */
function attentionColor(theme: PluginSidebarItemProps["theme"]): string {
  return (theme.colors as { attention?: string }).attention ?? theme.colors.statusWarning;
}

function InboxItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const { view } = useInbox(60_000);
  const count = needsDecisionCount(view?.runs ?? []);
  return (
    <SidebarRow
      icon="Inbox"
      active={currentScreen?.screenId === INBOX_SCREEN}
      onPress={() => openScreen({ screenId: INBOX_SCREEN })}
      trailing={count ? <Text style={{ color: attentionColor(theme), fontSize: 12, fontWeight: "600" }}>{count}</Text> : null}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  setOpenScreen((input) => client.openScreen(input));
  client.addScreen({ id: INBOX_SCREEN, title: "Inbox", Component: InboxScreen });
  client.addScreen({ id: REVIEW_SCREEN, title: "Review", Component: ReviewScreen });
  client.addSettingsScreen({ id: "inbox", title: "Inbox", icon: "Inbox", Component: InboxSettings });
  client.addTimelineRenderer({ kind: REVIEW_CARD, version: 1, schema: ReviewCardSchema, Component: ReviewCard });
  client.addCommandCenterItem({ id: "settings", title: "Inbox settings", icon: "Settings", context: "global", onSelect: ({ openSettings }) => openSettings("inbox") });
  client.addSidebarHeaderItem({ id: INBOX_SCREEN, title: "Inbox", Component: InboxItem });
  return () => {};
}
