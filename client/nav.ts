import type { PluginOpenScreenInput } from "@getpaseo/plugin/client";

// Screens get no openScreen prop; the client entry hands the context's one over at startup.
let open: ((input: PluginOpenScreenInput) => void) | null = null;
export const setOpenScreen = (fn: (input: PluginOpenScreenInput) => void) => {
  open = fn;
};
export const openScreen = (input: PluginOpenScreenInput) => open?.(input);
