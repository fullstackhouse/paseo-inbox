/**
 * Trust decides one thing: whether a review run may execute commands. Rules name people (Cerber
 * §14.2): `@login` (a `*` glob within the name), `@org/team`, `@org/*`; a leading `!` denies. Denials
 * win regardless of order, otherwise the first grant; no match, including no rules, is untrusted.
 * Repos are refused as rules: a repo takes PRs from anyone.
 */
export type TrustRule = { deny: boolean } & ({ kind: "login"; pattern: RegExp; text: string } | { kind: "team"; org: string; team: string; text: string } | { kind: "org"; org: string; text: string });

export function parseTrust(rules: readonly string[]): { rules: TrustRule[]; errors: string[] } {
  const parsed: TrustRule[] = [];
  const errors: string[] = [];
  for (const raw of rules.map((rule) => rule.trim()).filter(Boolean)) {
    const deny = raw.startsWith("!");
    const text = deny ? raw.slice(1).trim() : raw;
    const person = /^@([A-Za-z0-9*][A-Za-z0-9*-]*)$/.exec(text);
    const group = /^@([A-Za-z0-9-]+)\/([A-Za-z0-9*._-]+)$/.exec(text);
    if (person) parsed.push({ deny, kind: "login", text, pattern: new RegExp(`^${person[1]!.replace(/[-]/g, "\\-").replace(/\*/g, "[A-Za-z0-9-]*")}$`, "i") });
    else if (group && group[2] === "*") parsed.push({ deny, kind: "org", org: group[1]!, text });
    else if (group) parsed.push({ deny, kind: "team", org: group[1]!, team: group[2]!, text });
    else errors.push(`"${raw}" isn't a person rule. Use @login, @org/team or @org/*. Repos can't be trusted: a repo takes PRs from anyone.`);
  }
  return { rules: parsed, errors };
}

export interface Membership {
  inOrg(org: string, login: string): Promise<boolean>;
  inTeam(org: string, team: string, login: string): Promise<boolean>;
}

async function matches(rule: TrustRule, login: string, members: Membership): Promise<boolean> {
  try {
    if (rule.kind === "login") return rule.pattern.test(login);
    if (rule.kind === "org") return await members.inOrg(rule.org, login);
    return await members.inTeam(rule.org, rule.team, login);
  } catch {
    return false; // A failed lookup counts as "not a member".
  }
}

/** Whether `login` is trusted under `rules`, and the rule that decided it. */
export async function decideTrust(login: string, rules: readonly string[], members: Membership): Promise<{ trusted: boolean; because: string }> {
  if (!login) return { trusted: false, because: "unknown author" };
  const { rules: parsed } = parseTrust(rules);
  for (const rule of parsed.filter((candidate) => candidate.deny)) if (await matches(rule, login, members)) return { trusted: false, because: `denied by !${rule.text}` };
  for (const rule of parsed.filter((candidate) => !candidate.deny)) if (await matches(rule, login, members)) return { trusted: true, because: `trusted by ${rule.text}` };
  return { trusted: false, because: parsed.length ? "no trust rule matches" : "no trust rules (trust nobody)" };
}

/** Tools an untrusted run may use: reading the checkout and the inbox's own tools. Everything else is denied. */
export const UNTRUSTED_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite"]);
export const untrustedAllows = (toolName: string, mcpServer: string) => UNTRUSTED_TOOLS.has(toolName) || toolName.startsWith(`mcp__${mcpServer}__`);
