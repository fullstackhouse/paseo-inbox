import { z } from "zod";
import { REVIEW_TOOL, REVISE_TOOL, SeveritySchema, VerdictSchema } from "./review";

/** The plugin timeline item that stands in for a completed draft or revise tool call: what changed in the draft. */
export const DRAFT_CARD = { kind: "inbox-draft-change", version: 1 } as const;

const ChangeSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), id: z.string().nullable(), path: z.string(), line: z.number().nullable(), severity: SeveritySchema, body: z.string() }),
  // severity absent = unchanged; null = regraded to a note.
  z.object({ op: z.literal("edit"), id: z.string(), body: z.string().optional(), severity: SeveritySchema.optional() }),
  z.object({ op: z.literal("drop"), id: z.string() }),
]);
export type DraftChange = z.infer<typeof ChangeSchema>;

export const DraftCardSchema = z.object({
  tool: z.enum(["draft", "revise"]),
  /** The saved draft's headline ("approve · 85% · 1 nit"); only the draft tool reports it. */
  headline: z.string().nullable(),
  verdict: VerdictSchema.nullable(),
  confidence: z.number().nullable(),
  /** Draft-level fields the revision set: summary, reasoning, chapters. */
  fields: z.array(z.string()),
  changes: z.array(ChangeSchema),
  /** "c4: the human wrote or decided on it" */
  refused: z.array(z.string()),
});
export type DraftCard = z.infer<typeof DraftCardSchema>;

/** The parts of a `tool_call` timeline item this reads. */
export interface ToolCallLike {
  name: string;
  status: string;
  detail: { type: string; input?: unknown; output?: unknown };
}

// Claude names it mcp__inbox__inbox_review_draft; other providers join server and tool differently.
const TOOL = new RegExp(`inbox.*(${REVIEW_TOOL}|${REVISE_TOOL})$`);

type RawComment = { path?: unknown; line?: unknown; severity?: unknown; body?: unknown };

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const severity = (value: unknown) => {
  const parsed = SeveritySchema.safeParse(value ?? null);
  return parsed.success ? parsed.data : null;
};
const verdict = (value: unknown) => VerdictSchema.safeParse(value).data ?? null;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function added(raw: RawComment, id: string | null): DraftChange | null {
  const path = str(raw.path);
  const body = str(raw.body);
  return path && body ? { op: "add", id, path, line: num(raw.line), severity: severity(raw.severity), body } : null;
}

/** The output is a string, an MCP content array, or an object holding one, depending on the provider; read its text. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map(outputText).filter(Boolean).join("\n");
  if (output && typeof output === "object") {
    const { text, content, output: inner } = output as { text?: unknown; content?: unknown; output?: unknown };
    return [text, content, inner].map(outputText).filter(Boolean).join("\n");
  }
  return "";
}

/** The card to show instead of a draft/revise tool call, or undefined to keep the row as it is (running, failed, other tools). */
export function draftCardFor(item: ToolCallLike): DraftCard | undefined {
  const tool = item.name.match(TOOL)?.[1];
  if (!tool || item.status !== "completed") return undefined;
  const input = (item.detail.input ?? {}) as Record<string, unknown>;
  const text = outputText(item.detail.output);
  const base = { verdict: verdict(input.verdict), confidence: num(input.confidence) };

  if (tool === REVIEW_TOOL) {
    // "Saved: approve · 85% · 1 nit. Kept …" (see callTool in server/tools.ts)
    const headline = /Saved: (.+?)\.(?: |$)/.exec(text)?.[1] ?? null;
    if (!headline) return undefined;
    const changes = list(input.comments).map((raw) => added(raw as RawComment, null)).filter((change) => change !== null);
    return { tool: "draft", headline, ...base, fields: [], changes, refused: [] };
  }

  // "Applied: added c3, edited c2, set verdict. Refused: c4: no such comment. Ask the human …"
  const applied = new Set((/Applied: (.+?)\.(?: |$)/.exec(text)?.[1] ?? "").split(", ").filter(Boolean));
  const refusedText = /Refused: (.+?)\. Ask the human/.exec(text)?.[1];
  const refused = refusedText ? refusedText.split("; ") : [];
  const addedIds = [...applied].filter((entry) => entry.startsWith("added ")).map((entry) => entry.slice("added ".length));
  const changes: DraftChange[] = [];
  for (const raw of list(input.edit) as { id?: unknown; body?: unknown; severity?: unknown }[]) {
    const id = str(raw?.id);
    if (!id || !applied.has(`edited ${id}`)) continue;
    const body = str(raw.body);
    changes.push({ op: "edit", id, ...(body ? { body } : {}), ...(raw.severity !== undefined ? { severity: severity(raw.severity) } : {}) });
  }
  for (const raw of list(input.drop)) {
    const id = str(raw);
    if (id && applied.has(`removed ${id}`)) changes.push({ op: "drop", id });
  }
  list(input.add).forEach((raw, index) => {
    const change = added(raw as RawComment, addedIds[index] ?? null);
    if (change) changes.push(change);
  });
  const fields = ["summary", "reasoning", "chapters"].filter((field) => applied.has(`set ${field}`));
  return {
    tool: "revise",
    headline: null,
    verdict: applied.has("set verdict") ? base.verdict : null,
    confidence: applied.has("set confidence") ? base.confidence : null,
    fields,
    changes,
    refused,
  };
}
