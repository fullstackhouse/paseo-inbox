import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prWorktree } from "../index.server";
import { addToConfigFile, findClone } from "../server/checkouts";

function clone(dir: string, url: string) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
}

describe("findClone", () => {
  it("finds a clone next to the configured ones, by folder name and remote", () => {
    const home = mkdtempSync(join(tmpdir(), "inbox-home-"));
    clone(join(home, "work", "acme", "shop"), "git@github.com:acme/shop.git");
    clone(join(home, "work", "acme", "Api"), "https://github.com/Acme/api.git");
    expect(findClone("acme/api", ["~/work/acme/shop"], home)).toBe("~/work/acme/Api");
  });

  it("looks in the usual folders under home when nothing is configured", () => {
    const home = mkdtempSync(join(tmpdir(), "inbox-home-"));
    clone(join(home, "src", "api"), "https://github.com/acme/api");
    expect(findClone("acme/api", [], home)).toBe("~/src/api");
  });

  it("looks one owner folder below the usual folders", () => {
    const home = mkdtempSync(join(tmpdir(), "inbox-home-"));
    clone(join(home, "src", "acme", "api"), "git@github.com:acme/api.git");
    expect(findClone("acme/api", [], home)).toBe("~/src/acme/api");
  });

  it("ignores a folder of the same name that clones something else, or a lookalike repo", () => {
    const home = mkdtempSync(join(tmpdir(), "inbox-home-"));
    clone(join(home, "src", "api"), "git@github.com:other/api.git");
    clone(join(home, "code", "api"), "git@github.com:acme/api-v2.git");
    mkdirSync(join(home, "dev", "api"), { recursive: true });
    expect(findClone("acme/api", [], home)).toBeNull();
  });
});

describe("addToConfigFile", () => {
  it("adds the repo to checkouts and keeps the rest of the file", () => {
    const home = mkdtempSync(join(tmpdir(), "inbox-home-"));
    clone(join(home, "src", "api"), "git@github.com:acme/api.git");
    const file = join(home, "inbox.json");
    writeFileSync(file, JSON.stringify({ pollSeconds: 300, checkouts: { "acme/shop": "~/src/shop" }, rules: [] }));
    addToConfigFile(file, "acme/api", "~/src/api", home);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ pollSeconds: 300, checkouts: { "acme/shop": "~/src/shop", "acme/api": "~/src/api" }, rules: [] });
  });

  it("refuses a path that isn't a clone", () => {
    const home = mkdtempSync(join(tmpdir(), "inbox-home-"));
    const file = join(home, "inbox.json");
    writeFileSync(file, "{}");
    expect(() => addToConfigFile(file, "acme/api", "~/nowhere", home)).toThrow("isn't a git clone");
  });
});

describe("prWorktree", () => {
  it("names the PR's repo, so a clone's upstream remote can't redirect the checkout", () => {
    expect(prWorktree({ repo: "acme/shop", number: 7 })).toEqual({ mode: "checkout-pr", prNumber: 7, projectPath: "acme/shop" });
  });
});
