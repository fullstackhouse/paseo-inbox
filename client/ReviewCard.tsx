import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { openScreen } from "./nav";
import { REVIEW_SCREEN } from "./ReviewScreen";

export const REVIEW_CARD = "inbox-review";
export const ReviewCardSchema = z.object({ runId: z.string(), headline: z.string(), title: z.string(), pr: z.string() });

/**
 * The row the inbox used to append to a reviewer's chat when its draft was ready. New drafts get a
 * composer pill (`reviewPills.ts`); this keeps the cards already in older chats rendering.
 */
export function ReviewCard({ item, theme }: PluginTimelineItemProps<z.infer<typeof ReviewCardSchema>>) {
  const data = item.data;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open the review of ${data.pr}`}
      onPress={() => openScreen({ screenId: REVIEW_SCREEN, params: { runId: data.runId } })}
      style={{ borderWidth: 1, borderColor: theme.colors.accent, borderRadius: 10, padding: 12, gap: 4, marginVertical: 6 }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Review draft ready · {data.pr}</Text>
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "600" }} numberOfLines={2}>
        {data.title}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flex: 1 }}>{data.headline}</Text>
        <Text style={{ color: theme.colors.accent, fontSize: 14, fontWeight: "600" }}>Open review ›</Text>
      </View>
    </Pressable>
  );
}
