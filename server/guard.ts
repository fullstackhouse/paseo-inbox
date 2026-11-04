import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Env var marking a session as inbox-started; its value is the run id. */
export const RUN_ENV = "PASEO_INBOX_RUN";
const SHIM_DIR_ENV = "PASEO_INBOX_SHIM_DIR";

/**
 * The write guard, as a standalone Node script: `node guard.mjs <gh|git> ...args`. It refuses
 * GitHub writes and runs everything else with the real binary (the first one on PATH outside the
 * shim dir). Kept as source text so the file on disk is exactly what the tests execute.
 *
 * gh: only read subcommands pass (allowlist), and `gh api` only with GET and no mutation.
 * git: `push` is refused.
 */
export const GUARD_JS = String.raw`
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const READS = {
  pr: ["view", "list", "diff", "checks", "status", "checkout"],
  issue: ["view", "list", "status"],
  run: ["view", "list", "watch", "download"],
  workflow: ["view", "list"],
  release: ["view", "list", "download"],
  repo: ["view", "clone"],
  auth: ["status"],
  search: null,
  status: null,
  browse: null,
  help: null,
  version: null,
};

function positionals(args) {
  return args.filter((arg) => !arg.startsWith("-"));
}

function ghWrite(args) {
  const words = positionals(args);
  const [group, sub] = words;
  if (!group || args.includes("--help") || args.includes("--version")) return null;
  if (group === "api") return apiWrite(args);
  if (!(group in READS)) return "gh " + group + " is not a read command";
  const reads = READS[group];
  if (reads === null) return null;
  if (!sub || reads.includes(sub)) return null;
  return "gh " + group + " " + sub + " writes to GitHub";
}

function apiWrite(args) {
  let method = null;
  let fields = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-X" || arg === "--method") method = (args[i + 1] || "").toUpperCase();
    else if (arg.startsWith("--method=")) method = arg.slice(9).toUpperCase();
    else if (arg.startsWith("-X") && arg.length > 2) method = arg.slice(2).toUpperCase();
    else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(arg) || /^--(raw-)?field=/.test(arg)) fields = true;
  }
  if (args.some((arg) => /\bmutation\b/.test(arg))) return "gh api with a GraphQL mutation";
  // GraphQL is always a POST; without a mutation it only reads.
  if (positionals(args.slice(1))[0] === "graphql" || args[1] === "graphql") return null;
  const effective = method || (fields ? "POST" : "GET");
  return effective === "GET" ? null : "gh api " + effective;
}

function gitWrite(args) {
  // Skip global options, including the ones that take a value.
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i]) ? 2 : 1;
  return args[i] === "push" ? "git push" : null;
}

function findReal(tool) {
  const shimDir = process.env.${SHIM_DIR_ENV};
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir || dir === shimDir) continue;
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

const [tool, ...args] = process.argv.slice(2);
const reason = tool === "gh" ? ghWrite(args) : tool === "git" ? gitWrite(args) : null;
if (reason) {
  process.stderr.write(
    "paseo-inbox: blocked (" + reason + "). Agents started by the inbox cannot write to GitHub. " +
      "Create an ask whose Send action carries this exact command, and the human will run it.\n",
  );
  process.exit(1);
}
const real = findReal(tool);
if (!real) {
  process.stderr.write("paseo-inbox: " + tool + " not found on PATH\n");
  process.exit(127);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(real, args, { stdio: "inherit", env });
process.exit(result.status ?? 1);
`;

/** Writes guard.mjs plus `gh` and `git` shims into `<dataDir>/shims`; returns the shim dir. */
export function installShims(dataDir: string, node = process.execPath): string {
  const dir = join(dataDir, "shims");
  mkdirSync(dir, { recursive: true });
  const guard = join(dataDir, "guard.mjs");
  writeFileSync(guard, GUARD_JS);
  for (const tool of ["gh", "git"]) {
    const path = join(dir, tool);
    // Inside the Paseo app the plugin's execPath is its Electron helper, which is Node only with this env set.
    writeFileSync(path, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${node}" "${guard}" ${tool} "$@"\n`);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** Session env for an inbox-started agent: shims first on PATH. Other sessions are returned unchanged. */
export function guardEnv(env: Record<string, string>, shimDir: string): Record<string, string> {
  if (!env[RUN_ENV]) return env;
  const rest = (env.PATH ?? process.env.PATH ?? "").split(":").filter((dir) => dir && dir !== shimDir);
  return { ...env, PATH: [shimDir, ...rest].join(":"), [SHIM_DIR_ENV]: shimDir };
}
