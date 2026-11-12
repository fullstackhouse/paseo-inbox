import type { AgentPermissionRequest, McpToolRef } from "@getpaseo/protocol/agent-types";
import { assertQualifiedRefs, draftHeadline, MCP_SERVER, PR_TOOL, prContext, replaceDraft, REVIEW_TOOL, type PrDetails, ReviewInputSchema, REVISE_TOOL, ReviseInputSchema, reviseDraft, TOOLS } from "../shared/review";
import { untrustedAllows } from "../shared/trust";
import type { Inbox } from "./inbox";
import type { ReviewStore } from "./reviews";

export const PREAPPROVED: McpToolRef[] = TOOLS.map((tool) => ({ kind: "mcp", server: MCP_SERVER, tool: tool.name }));

export function isInboxPermission(request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">): boolean {
  if (request.kind !== "tool") return false;
  if (request.name.startsWith(`mcp__${MCP_SERVER}__`)) return true;
  return request.name === "CodexMcpElicitation" && request.metadata?.serverName === MCP_SERVER;
}

/**
 * How the inbox answers a permission prompt from one of its agents: inbox tools always pass; for a
 * read-only (untrusted) run, reading passes and everything else is denied; otherwise it's not ours to
 * answer (null), and the agent's own mode decides.
 */
export function permissionAnswer(request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">, trusted: boolean | undefined): "allow" | "deny" | null {
  if (isInboxPermission(request)) return "allow";
  if (trusted !== false) return null;
  return request.kind === "tool" && untrustedAllows(request.name, MCP_SERVER) ? "allow" : "deny";
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export async function callTool(
  inbox: Inbox,
  reviews: ReviewStore,
  agentId: string | null,
  name: string,
  args: unknown,
  now = new Date().toISOString(),
  details?: (repo: string, number: number) => Promise<PrDetails>,
): Promise<ToolResult> {
  try {
    const run = agentId ? inbox.runForAgent(agentId) : null;
    if (!run) throw new Error("Only agents started by paseo-inbox can use the inbox tools");
    if (name === PR_TOOL) {
      const pr = inbox.item(run.itemKey)?.pr;
      if (!pr || !details) throw new Error("The PR isn't available");
      return { text: prContext(pr, await details(pr.repo, pr.number)) };
    }
    const previous = reviews.get(run.id);
    const repo = inbox.item(run.itemKey)?.pr.repo;
    if (name === REVIEW_TOOL) {
      const draft = replaceDraft(previous, ReviewInputSchema.parse(args), run, now);
      if (repo) assertQualifiedRefs(draft, repo);
      reviews.save(draft);
      inbox.markDrafted(run.id, `review drafted: ${draftHeadline(draft)}`);
      const kept = previous ? draft.comments.filter((comment) => comment.author === "human" || comment.status !== "draft").length : 0;
      return { text: `Saved: ${draftHeadline(draft)}.${kept ? ` Kept ${kept} comment(s) the human wrote or decided on.` : ""} The human reads and posts it from the Inbox; don't post it yourself, and create no ask for it.` };
    }
    if (name === REVISE_TOOL) {
      if (!previous) throw new Error(`No draft yet: save one with ${REVIEW_TOOL} first`);
      const { draft, applied, refused } = reviseDraft(previous, ReviseInputSchema.parse(args));
      if (repo) assertQualifiedRefs(draft, repo);
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
