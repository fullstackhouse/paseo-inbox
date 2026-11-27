import type { AgentPermissionRequest, McpToolRef } from "@getpaseo/protocol/agent-types";
import { assertQualifiedRefs, draftHeadline, MCP_SERVER, PR_TOOL, prContext, replaceDraft, REVIEW_TOOL, type PrDetails, ReviewInputSchema, REVISE_TOOL, ReviseInputSchema, reviseDraft, TOOLS } from "../shared/review";
import { untrustedAllows } from "../shared/trust";
import type { Inbox } from "./inbox";
import type { ReviewStore } from "./reviews";

export const PREAPPROVED: McpToolRef[] = TOOLS.map((tool) => ({ kind: "mcp", server: MCP_SERVER, tool: tool.name }));

interface AgentToolConfig {
  provider: string;
  mcpServers?: Record<string, unknown>;
  toolPolicy?: { preapproved: McpToolRef[] };
}

/**
 * Attaches the inbox MCP server, and preapproves its tools where the provider can hold an exact grant
 * (`toolGrantSupport`). Elsewhere the tools still attach and `permissionAnswer` decides each call.
 */
export function withInboxTools<T extends AgentToolConfig>(
  config: T,
  mcp: unknown,
  exactGrants: boolean,
): T & Pick<AgentToolConfig, "toolPolicy"> {
  const attached = { ...config, mcpServers: { ...config.mcpServers, [MCP_SERVER]: mcp } };
  if (!exactGrants) return attached;
  return { ...attached, toolPolicy: { preapproved: [...(config.toolPolicy?.preapproved ?? []), ...PREAPPROVED] } };
}

/**
 * Whether a permission request is for one of the inbox tools. `tool` is the host's provider-neutral
 * name for it (fullstackhouse/paseo#288); without it, match the provider's own names.
 */
export function isInboxPermission(
  request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">,
  tool?: { server: string },
): boolean {
  if (request.kind !== "tool") return false;
  if (tool) return tool.server === MCP_SERVER;
  // COMPAT(pluginToolGrants): hosts before #288 send no `tool`. Remove after 2027-05-31.
  if (request.name.startsWith(`mcp__${MCP_SERVER}__`)) return true;
  return request.name === "CodexMcpElicitation" && request.metadata?.serverName === MCP_SERVER;
}

/**
 * How the inbox answers a permission prompt from one of its agents: inbox tools always pass; for a
 * read-only (untrusted) run, reading passes and everything else is denied; otherwise it's not ours to
 * answer (null), and the agent's own mode decides.
 */
export function permissionAnswer(
  request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">,
  trusted: boolean | undefined,
  tool?: { server: string },
): "allow" | "deny" | null {
  if (isInboxPermission(request, tool)) return "allow";
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
  /** The human's previous review as `inbox_pr` lines (`priorSection`); a failure just leaves it out. */
  prior?: (runId: string) => Promise<string[]>,
): Promise<ToolResult> {
  try {
    const run = agentId ? inbox.runForAgent(agentId) : null;
    if (!run) throw new Error("Only agents started by paseo-inbox can use the inbox tools");
    const pr = inbox.item(run.itemKey)?.pr;
    if (name === PR_TOOL) {
      if (!pr || !details) throw new Error("The PR isn't available");
      const [prDetails, previous] = await Promise.all([details(pr.repo, pr.number), prior ? prior(run.id).catch(() => []) : []]);
      return { text: prContext(pr, prDetails, undefined, previous) };
    }
    const previous = reviews.get(run.id);
    const repo = pr?.repo;
    // The row and the notification read this reason: on your own PR it says comment, as it posts.
    const own = pr ? inbox.ownPr(pr) : false;
    if (name === REVIEW_TOOL) {
      const draft = replaceDraft(previous, ReviewInputSchema.parse(args), run, now);
      if (repo) assertQualifiedRefs(draft, repo);
      reviews.save(draft);
      inbox.markDrafted(run.id, `review drafted: ${draftHeadline(draft, own)}`);
      const kept = previous ? draft.comments.filter((comment) => comment.author === "human" || comment.status !== "draft").length : 0;
      return { text: `Saved: ${draftHeadline(draft)}.${kept ? ` Kept ${kept} comment(s) the human wrote or decided on.` : ""} The human reads and posts it from the Inbox; don't post it yourself, and create no ask for it.` };
    }
    if (name === REVISE_TOOL) {
      if (!previous) throw new Error(`No draft yet: save one with ${REVIEW_TOOL} first`);
      const { draft, applied, refused } = reviseDraft(previous, ReviseInputSchema.parse(args));
      if (repo) assertQualifiedRefs(draft, repo);
      reviews.save(draft);
      inbox.markDrafted(run.id, `review drafted: ${draftHeadline(draft, own)}`);
      const lines = [applied.length ? `Applied: ${applied.join(", ")}.` : "Nothing changed.", ...(refused.length ? [`Refused: ${refused.join("; ")}. Those are the human's to change; say so in your reply.`] : [])];
      return { text: lines.join(" "), isError: !applied.length && refused.length > 0 };
    }
    throw new Error(`Unknown tool ${name}`);
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), isError: true };
  }
}
