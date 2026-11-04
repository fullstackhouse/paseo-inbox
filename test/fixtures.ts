import { ConfigSchema, emptyState, prKey, type Config, type Pr } from "../shared/inbox";

export const NOW = "2026-11-04T12:00:00.000Z";
export const later = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

export function pr(overrides: Partial<Pr> = {}): Pr {
  const repo = overrides.repo ?? "acme/shop";
  const number = overrides.number ?? 7;
  return {
    key: prKey(repo, number),
    repo,
    number,
    url: `https://github.com/${repo}/pull/${number}`,
    title: "Add the basket page",
    headSha: "aaaaaaa111",
    isDraft: false,
    labels: [],
    files: ["src/basket/BasketPage.tsx"],
    checks: "passing",
    ...overrides,
  };
}

export function config(overrides: Partial<Config> = {}): Config {
  return ConfigSchema.parse({
    checkouts: { "acme/shop": "/src/shop" },
    sources: { review: { github: "is:open review-requested:@me" }, qa: { github: "is:open label:needs-qa" }, mine: { github: "is:open author:@me" } },
    rules: [
      { name: "draft-review", source: "review", prompt: "Review {{pr.url}}" },
      { name: "qa", source: "qa", paths: ["**/*.tsx"], prompt: "QA #{{pr.number}}" },
      { name: "fix-ci", source: "mine", when: { checks: "failing" }, rerun: "once", prompt: "Fix CI on {{pr.url}}" },
    ],
    ...overrides,
  });
}

export { emptyState };
