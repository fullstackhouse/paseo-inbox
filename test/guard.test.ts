import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { guardEnv, installShims, RUN_ENV } from "../server/guard";

// Real `gh`/`git` stand-ins that echo their args, so a passed command is visible in stdout.
let shimDir: string;
let env: Record<string, string>;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "inbox-guard-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const tool of ["gh", "git"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "real ${tool} $*${tool === "gh" ? " (electron-env: $ELECTRON_RUN_AS_NODE)" : ""}"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  shimDir = installShims(join(root, "data"));
  env = guardEnv({ [RUN_ENV]: "run-1", PATH: `${bin}:/usr/bin:/bin` }, shimDir);
});

const run = (tool: string, ...args: string[]) => spawnSync(tool, args, { env, encoding: "utf8" });

describe("shims", () => {
  it("run the guard under an Electron helper too, without leaking the Node switch to the real tool", () => {
    const result = spawnSync("gh", ["pr", "view", "7"], { env: { ...env, PRINT_ENV: "1" }, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(readFileSync(join(shimDir, "gh"), "utf8")).toContain("ELECTRON_RUN_AS_NODE=1 exec");
    expect(spawnSync("sh", ["-c", "gh pr view 7; true"], { env, encoding: "utf8" }).stdout).toBe("real gh pr view 7 (electron-env: )\n");
  });
});

describe("guardEnv", () => {
  it("puts the shims first only for inbox sessions", () => {
    expect(env.PATH!.split(":")[0]).toBe(shimDir);
    expect(guardEnv({ PATH: "/usr/bin" }, shimDir)).toEqual({ PATH: "/usr/bin" });
  });
  it("does not stack the shim dir on resume", () => {
    expect(guardEnv(env, shimDir).PATH!.split(":").filter((dir) => dir === shimDir)).toHaveLength(1);
  });
});

describe("gh shim", () => {
  it.each([
    ["pr", "view", "7", "--json", "title"],
    ["pr", "diff", "7"],
    ["pr", "checkout", "7"],
    ["search", "prs", "is:open"],
    ["api", "repos/acme/shop/pulls/7"],
    ["api", "-X", "GET", "repos/acme/shop/pulls", "-f", "state=open"],
    ["api", "graphql", "-f", "query=query { viewer { login } }"],
    ["run", "view", "123", "--log-failed"],
  ])("passes reads: gh %s", (...args) => {
    const result = run("gh", ...args);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`real gh ${args.join(" ")} (electron-env: )`);
  });

  it.each([
    [["pr", "review", "7", "--approve"], "gh pr review writes to GitHub"],
    [["pr", "comment", "7", "--body", "hi"], "gh pr comment writes to GitHub"],
    [["pr", "merge", "7", "--squash"], "gh pr merge writes to GitHub"],
    [["pr", "edit", "7", "--add-label", "qa-approved"], "gh pr edit writes to GitHub"],
    [["issue", "create", "--title", "x"], "gh issue create writes to GitHub"],
    [["api", "repos/acme/shop/issues/7/comments", "-f", "body=hi"], "gh api POST"],
    [["api", "--method", "DELETE", "repos/acme/shop/labels/x"], "gh api DELETE"],
    [["api", "graphql", "-f", "query=mutation { addComment(input: {}) { clientMutationId } }"], "gh api with a GraphQL mutation"],
    [["label", "create", "x"], "gh label is not a read command"],
  ])("blocks writes: gh %j", (args, reason) => {
    const result = run("gh", ...args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`blocked (${reason})`);
    expect(result.stderr).toContain("Create an ask");
  });
});

describe("git shim", () => {
  it("passes non-push commands", () => {
    expect(run("git", "-C", "/tmp", "fetch", "origin").stdout.trim()).toBe("real git -C /tmp fetch origin");
    expect(run("git", "commit", "-m", "push the button").status).toBe(0);
  });
  it("blocks push, also behind global options", () => {
    for (const args of [["push"], ["push", "origin", "HEAD:main"], ["-C", "/tmp", "push"], ["-c", "x=y", "push", "-f"]]) {
      const result = run("git", ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("blocked (git push)");
    }
  });
});
