export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; inlines: Inline[] }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

type BlockBody =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };
/** `line`: the 1-based source line the block starts on, so comments can sit under their paragraph. */
export type Block = BlockBody & { line: number };

/** Inline markdown: `code`, **bold**, *italic* / _italic_, [text](url), ![image](url) (as a link). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /(`[^`]+`)|(\*\*(?:[^*]|\*(?!\*))+?\*\*)|(!?\[[^\]]*\]\([^)\s]+\))|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "text", text: text.slice(last, index) });
    const token = match[0];
    if (match[1]) out.push({ kind: "code", text: token.slice(1, -1) });
    else if (match[2]) out.push({ kind: "bold", inlines: parseInline(token.slice(2, -2)) });
    else if (match[3]) {
      const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(token)!;
      out.push({ kind: "link", text: link[1] ? `🖼 ${link[2] || "image"}` : link[2]!, url: link[3]! });
    } else out.push({ kind: "italic", text: token.slice(1, -1) });
    last = index + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => parseInline(cell.trim().replace(/\\\|/g, "|")));
const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Block markdown, enough for PR descriptions, review text and spec documents. HTML comments are dropped. */
export function parseMarkdown(source: string): Block[] {
  // Blank out HTML comments line for line, so block line numbers still match the source.
  const lines = source
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ""))
    .split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let paragraphLine = 0;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" ")), line: paragraphLine });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const at = i + 1;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ kind: "code", text: code.join("\n"), line: at });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, inlines: parseInline(heading[2]!.trim()), line: at });
      continue;
    }
    if (/^\s*\|/.test(line) && SEPARATOR.test(lines[i + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]!); i++) rows.push(cells(lines[i]!));
      i--;
      blocks.push({ kind: "table", header, rows, line: at });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule", line: at });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const previous = blocks[blocks.length - 1];
      const text = item[2]!.replace(/^\[( |x)\]\s+/i, (box) => (/x/i.test(box) ? "☑ " : "☐ "));
      if (previous?.kind === "list" && previous.ordered === ordered) previous.items.push(parseInline(text));
      else blocks.push({ kind: "list", ordered, items: [parseInline(text)], line: at });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      blocks.push({ kind: "quote", inlines: parseInline(line.replace(/^\s*>\s?/, "")), line: at });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A wrapped list item continues the last item.
    const previous = blocks[blocks.length - 1];
    if (!paragraph.length && previous?.kind === "list" && /^\s{2,}/.test(line)) {
      previous.items[previous.items.length - 1]!.push({ kind: "text", text: " " }, ...parseInline(line.trim()));
      continue;
    }
    if (!paragraph.length) paragraphLine = at;
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** The new-side text of an added file, rebuilt from its patch (one hunk starting at line 1). */
export function addedText(patch: string | undefined): string | null {
  if (!patch || !/^@@ -0,0 \+1/.test(patch)) return null;
  return patch
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
}

export const isMarkdownPath = (path: string) => /\.(md|mdx|markdown)$/i.test(path);
