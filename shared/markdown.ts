export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; inlines: Inline[] }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; url: string };

export type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "code"; text: string }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "rule" };

/** Inline markdown: `code`, **bold**, *italic* / _italic_, [text](url). Everything else is text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pattern = /(`[^`]+`)|(\*\*(?:[^*]|\*(?!\*))+?\*\*)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*)|(\b_[^_\s][^_]*_\b)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ kind: "text", text: text.slice(last, index) });
    const token = match[0];
    if (match[1]) out.push({ kind: "code", text: token.slice(1, -1) });
    else if (match[2]) out.push({ kind: "bold", inlines: parseInline(token.slice(2, -2)) });
    else if (match[3]) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      out.push({ kind: "link", text: link[1]!, url: link[2]! });
    } else out.push({ kind: "italic", text: token.slice(1, -1) });
    last = index + token.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** Block markdown, enough for PR descriptions and review summaries. HTML comments are dropped. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", inlines: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]!); i++) code.push(lines[i]!);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1]!.length, inlines: parseInline(heading[2]!.trim()) });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = /\d/.test(item[1]!);
      const previous = blocks[blocks.length - 1];
      const text = item[2]!.replace(/^\[( |x)\]\s+/i, (box) => (/x/i.test(box) ? "☑ " : "☐ "));
      if (previous?.kind === "list" && previous.ordered === ordered) previous.items.push(parseInline(text));
      else blocks.push({ kind: "list", ordered, items: [parseInline(text)] });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      blocks.push({ kind: "quote", inlines: parseInline(line.replace(/^\s*>\s?/, "")) });
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
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
