/** Longest quote sent with a question; a longer selection keeps its start and end. */
export const QUOTE_MAX = 1200;

/** The selected text as it goes to the reviewer: trailing spaces and blank edges trimmed, long ones cut in the middle. Null when nothing but whitespace was selected. */
export function quoteFor(selected: string): string | null {
  const lines = selected.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length && !lines[0]!.trim()) lines.shift();
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  const text = lines.join("\n");
  if (!text.trim()) return null;
  if (text.length <= QUOTE_MAX) return text;
  const half = Math.floor((QUOTE_MAX - 3) / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

/** The message a question about part of the review sends: what it's about, the quote as a Markdown block quote, then the question. */
export function askMessage(about: string, question: string, quote?: string): string {
  const quoted = quote ? `\n\n${quote.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}` : "";
  return `About ${about}:${quoted}\n\n${question}`;
}
