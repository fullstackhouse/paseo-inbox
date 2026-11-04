import { defineSettings } from "@getpaseo/plugin";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ConfigSchema } from "./inbox";

/** The inbox's configuration in Paseo's own settings store; the same shape as the legacy inbox.json. */
export const inboxSettings = defineSettings({ id: "inbox", scope: "host", version: 1, schema: ConfigSchema });

/** The legacy ~/.paseo/inbox.json, if any, so the settings screen can import it. */
export const readLegacyConfig = defineRpc({
  name: "inbox.legacy_config",
  input: z.object({}),
  output: z.object({ path: z.string(), config: ConfigSchema.nullable(), error: z.string().nullable() }),
});
