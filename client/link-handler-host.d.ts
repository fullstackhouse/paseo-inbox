import type { PluginCommandCapabilities } from "@getpaseo/plugin/client";

// COMPAT(link-handlers): added in Paseo v0.17.1 FSH; remove after SDK publication (2027-01-31).
// Mirrors PluginLinkHandlerContribution in packages/plugin/src/client/contracts.ts of fullstackhouse/paseo.
declare module "@getpaseo/plugin/client" {
  interface PluginLinkHandlerContext extends PluginCommandCapabilities {
    url: string;
    workspaceId: string | null;
  }
  interface PluginLinkHandlerContribution {
    id: string;
    title: string;
    icon?: string;
    match(url: string): boolean;
    open(context: PluginLinkHandlerContext): void | Promise<void>;
  }
  interface PluginClientContext {
    /** Missing on hosts older than the FSH build that added link handlers. */
    addLinkHandler?: (contribution: PluginLinkHandlerContribution) => () => void;
  }
}
