import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const HOME_ROOTS = ["src", "code", "projects", "dev", "git", "repos", "Developer", "workspace"];

const expandHome = (path: string, home: string) => (path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path);
const contractHome = (path: string, home: string) => (path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/** True when the clone at `dir` has a remote pointing at github.com/`repo`. Reads .git/config, no git process. */
function clones(dir: string, repo: string): boolean {
  const config = join(dir, ".git", "config");
  if (!existsSync(config)) return false;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wanted = new RegExp(`github\\.com[:/]${escape(repo.toLowerCase())}(\\.git)?/?$`);
  return readFileSync(config, "utf8")
    .split("\n")
    .map((line) => /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1]?.toLowerCase())
    .some((url) => url !== undefined && wanted.test(url));
}

const folders = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
};

/**
 * A clone of `repo` next to the repos already configured, or in a usual folder under home (~/src, ~/code…, or one owner folder below): the folder
 * named like the repo whose remote points at it. Returns the path with `~`, or null.
 */
export function findClone(repo: string, configured: string[], home = homedir()): string | null {
  const name = repo.split("/")[1]?.toLowerCase();
  if (!name) return null;
  // Usual folders hold repos directly (~/src/api) or under an owner folder (~/src/acme/api).
  const usual = HOME_ROOTS.map((root) => join(home, root)).flatMap((root) => [root, ...folders(root)]);
  const roots = [...new Set([...configured.map((path) => dirname(expandHome(path, home))), ...usual])];
  for (const root of roots)
    for (const dir of folders(root).filter((candidate) => basename(candidate).toLowerCase() === name)) if (clones(dir, repo)) return contractHome(dir, home);
  return null;
}

/** Adds `repo → path` to the checkouts of the JSON config at `file`, keeping everything else. */
export function addToConfigFile(file: string, repo: string, path: string, home = homedir()): void {
  if (!existsSync(join(expandHome(path, home), ".git"))) throw new Error(`${path} isn't a git clone`);
  const config = JSON.parse(readFileSync(file, "utf8")) as { checkouts?: Record<string, string> };
  config.checkouts = { ...config.checkouts, [repo]: path };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(config, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}
