import type { AgentPermissionRequest, McpToolRef } from "@getpaseo/protocol/agent-types";
import { draftHeadline, MCP_SERVER, replaceDraft, REVIEW_TOOL, ReviewInputSchema, REVISE_TOOL, ReviseInputSchema, reviseDraft, TOOLS } from "../shared/review";
import type { Inbox } from "./inbox";
import type { ReviewStore } from "./reviews";

export const PREAPPROVED: McpToolRef[] = TOOLS.map((tool) => ({ kind: "mcp", server: MCP_SERVER, tool: tool.name }));

export function isInboxPermission(request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">): boolean {
  if (request.kind !== "tool") return false;
  if (request.name.startsWith(`mcp__${MCP_SERVER}__`)) return true;
  return request.name === "CodexMcpElicitation" && request.metadata?.serverName === MCP_SERVER;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export function callTool(inbox: Inbox, reviews: ReviewStore, agentId: string | null, name: string, args: unknown, now = new Date().toISOString()): ToolResult {
  try {
    const run = agentId ? inbox.runForAgent(agentId) : null;
    if (!run) throw new Error("Only agents started by paseo-inbox can save a review draft");
    const previous = reviews.get(run.id);
    if (name === REVIEW_TOOL) {
      const draft = replaceDraft(previous, ReviewInputSchema.parse(args), run, now);
      reviews.save(draft);
      inbox.markDrafted(run.id, `review drafted: ${draftHeadline(draft)}`);
      const kept = previous ? draft.comments.filter((comment) => comment.author === "human" || comment.status !== "draft").length : 0;
      return { text: `Saved: ${draftHeadline(draft)}.${kept ? ` Kept ${kept} comment(s) the human wrote or decided on.` : ""} The human reads and posts it from the Inbox; don't post it yourself.` };
    }
    if (name === REVISE_TOOL) {
      if (!previous) throw new Error(`No draft yet: save one with ${REVIEW_TOOL} first`);
      const { draft, applied, refused } = reviseDraft(previous, ReviseInputSchema.parse(args));
      reviews.save(draft);
      inbox.markDrafted(run.id, `review drafted: ${draftHeadline(draft)}`);
      const lines = [applied.length ? `Applied: ${applied.join(", ")}.` : "Nothing changed.", ...(refused.length ? [`Refused: ${refused.join("; ")}. Ask the human to change those.`] : [])];
      return { text: lines.join(" "), isError: !applied.length && refused.length > 0 };
    }
    throw new Error(`Unknown tool ${name}`);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}
