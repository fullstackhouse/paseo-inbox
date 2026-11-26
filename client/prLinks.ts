import { openExternalUrl, type PluginClientContext } from "@getpaseo/plugin/client";
import { prLink } from "../shared/inbox";
import { previewPr } from "../shared/review";
import { openPrReview } from "./nav";

/**
 * GitHub PR links in chat and Markdown open in the review screen: the PR's review, or a preview to start one.
 * The host's link menu keeps "Open in browser". An issues link (what `#123` resolves to) opens here only once
 * GitHub confirms it is a PR; a real issue goes to the browser.
 */
export function contributePrLinks(client: PluginClientContext): () => void {
  // COMPAT(link-handlers): hosts without link handlers keep opening PR links in the browser.
  if (!client.addLinkHandler) return () => undefined;
  return client.addLinkHandler({
    id: "pull-request",
    title: "Open in Inbox",
    icon: "Inbox",
    match: (url) => prLink(url) !== null,
    async open({ url, workspaceId, rpc }) {
      const link = prLink(url);
      if (!link) return void (await openExternalUrl(url));
      if (link.maybeIssue) {
        const isPr = await rpc(previewPr, { ref: link.ref }).then(() => true, () => false);
        if (!isPr) return void (await openExternalUrl(url));
      }
      openPrReview(link.ref, workspaceId);
    },
  });
}
