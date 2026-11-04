import type { AgentPermissionRequest, McpToolRef } from "@getpaseo/protocol/agent-types";
import { draftHeadline, MCP_SERVER, REVIEW_TOOL, ReviewInputSchema, toDraft, TOOLS } from "../shared/review";
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
    if (name !== REVIEW_TOOL) throw new Error(`Unknown tool ${name}`);
    const run = agentId ? inbox.runForAgent(agentId) : null;
    if (!run) throw new Error("Only agents started by paseo-inbox can save a review draft");
    const draft = toDraft(ReviewInputSchema.parse(args), run, now);
    reviews.save(draft);
    inbox.markDrafted(run.id, `review drafted: ${draftHeadline(draft)}`);
    return { text: `Saved. The human will read it in the Inbox and post it from there: ${draftHeadline(draft)}. Don't post it yourself.` };
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}
