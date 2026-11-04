export type TokenKind = "keyword" | "string" | "comment" | "number" | "plain";
export interface Token {
  kind: TokenKind;
  text: string;
}

type Lang = { keywords: Set<string>; line: string[]; block?: [string, string]; quotes: string };

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));
const JS = words(`abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface keyof let namespace new null of private protected public readonly return satisfies set static super switch this throw true try type typeof undefined var void while with yield`);
const LANGS: Record<string, Lang> = {
  js: { keywords: JS, line: ["//"], block: ["/*", "*/"], quotes: "\"'`" },
  py: { keywords: words(`and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self`), line: ["#"], quotes: "\"'" },
  go: { keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map nil package range return select struct switch type var true false`), line: ["//"], block: ["/*", "*/"], quotes: "\"'`" },
  sh: { keywords: words(`if then else elif fi for while until do done case esac in function return local export set unset echo exit`), line: ["#"], quotes: "\"'" },
  sql: { keywords: words(`select from where and or not insert into values update set delete create table alter drop index primary key foreign references join left right inner outer on group by order limit offset as null is distinct union returning with`), line: ["--"], block: ["/*", "*/"], quotes: "'\"" },
  css: { keywords: words(`important media import root`), line: [], block: ["/*", "*/"], quotes: "\"'" },
  yaml: { keywords: words(`true false null yes no on off`), line: ["#"], quotes: "\"'" },
  tf: { keywords: words(`resource data module variable output locals provider terraform for_each count depends_on true false null`), line: ["#", "//"], block: ["/*", "*/"], quotes: "\"" },
};
const EXT: Record<string, string> = {
  ts: "js", tsx: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", json: "js", java: "js", kt: "js", swift: "js", c: "js", h: "js", cpp: "js", cs: "js", rs: "js", php: "js", dart: "js",
  py: "py", rb: "py", go: "go", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", sql: "sql", css: "css", scss: "css", less: "css", yml: "yaml", yaml: "yaml", toml: "yaml", tf: "tf", hcl: "tf",
};

export function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  if (/^Dockerfile|\.env/.test(name)) return "sh";
  return EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? null;
}

/**
 * Tokenizes one diff line. `inBlock` carries an open block comment across lines (diff lines of one hunk
 * are contiguous). Deliberately small: keywords, strings, comments and numbers, not a grammar.
 */
export function highlightLine(text: string, language: string | null, inBlock = false): { tokens: Token[]; inBlock: boolean } {
  const lang = language ? LANGS[language] : undefined;
  if (!lang) return { tokens: [{ kind: "plain", text }], inBlock: false };
  const tokens: Token[] = [];
  const push = (kind: TokenKind, value: string) => {
    if (!value) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === kind) last.text += value;
    else tokens.push({ kind, text: value });
  };
  let i = 0;
  if (inBlock && lang.block) {
    const end = text.indexOf(lang.block[1]);
    if (end < 0) return { tokens: [{ kind: "comment", text }], inBlock: true };
    push("comment", text.slice(0, end + lang.block[1].length));
    i = end + lang.block[1].length;
  }
  while (i < text.length) {
    const rest = text.slice(i);
    if (lang.line.some((marker) => rest.startsWith(marker))) {
      push("comment", rest);
      break;
    }
    if (lang.block && rest.startsWith(lang.block[0])) {
      const end = rest.indexOf(lang.block[1], lang.block[0].length);
      if (end < 0) {
        push("comment", rest);
        return { tokens, inBlock: true };
      }
      push("comment", rest.slice(0, end + lang.block[1].length));
      i += end + lang.block[1].length;
      continue;
    }
    const c = text[i]!;
    if (lang.quotes.includes(c)) {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      push("string", text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(rest);
    if (word) {
      const value = word[0];
      push(lang.keywords.has(language === "sql" ? value.toLowerCase() : value) ? "keyword" : "plain", value);
      i += value.length;
      continue;
    }
    const number = /^\d[\d_.]*(?:e[+-]?\d+)?[a-z]*/i.exec(rest);
    if (number) {
      push("number", number[0]);
      i += number[0].length;
      continue;
    }
    push("plain", c);
    i++;
  }
  return { tokens, inBlock: false };
}
