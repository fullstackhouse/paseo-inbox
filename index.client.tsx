import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { INBOX_SCREEN, InboxScreen } from "./client/InboxScreen";
import { useInbox } from "./client/useInbox";
import { needsDecisionCount } from "./shared/inbox";

function InboxItem({ currentScreen, openScreen, theme }: PluginSidebarItemProps) {
  const { view } = useInbox(60_000);
  const count = needsDecisionCount(view?.runs ?? []);
  return (
    <SidebarRow
      icon="Inbox"
      active={currentScreen?.screenId === INBOX_SCREEN}
      onPress={() => openScreen({ screenId: INBOX_SCREEN })}
      trailing={count ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{count}</Text> : null}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: INBOX_SCREEN, title: "Inbox", Component: InboxScreen });
  client.addSidebarHeaderItem({ id: INBOX_SCREEN, title: "Inbox", Component: InboxItem });
  return () => {};
}
