import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, emptyState, ItemSchema, RunSchema, type Config, type Item, type Run, type State } from "../shared/inbox";

export const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");

export function dataDir(): string {
  const dir = process.env.PASEO_INBOX_DIR ?? join(paseoHome(), "plugin-data", "inbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const configPath = () => process.env.PASEO_INBOX_CONFIG ?? join(paseoHome(), "inbox.json");

const expandHome = (path: string) => (path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path);

export const expandCheckouts = (config: Config): Config => ({ ...config, checkouts: Object.fromEntries(Object.entries(config.checkouts).map(([repo, dir]) => [repo, expandHome(dir)])) });

/** The legacy inbox.json, or null when it doesn't exist. Throws with the zod message when it is invalid. */
export function loadConfig(path = configPath()): Config | null {
  if (!existsSync(path)) return null;
  return expandCheckouts(ConfigSchema.parse(JSON.parse(readFileSync(path, "utf8"))));
}

/** Inbox state in one JSON file. Single writer (the plugin process), written atomically. */
export class StateStore {
  private readonly path: string;

  constructor(dir: string) {
    this.path = join(dir, "state.json");
  }

  /**
   * Reads each item and run on its own and drops only the ones it can't read, such as a run state from
   * a newer build after a rollback. The next save overwrites the file, so whenever something is
   * dropped the original is copied aside first.
   */
  load(): State {
    if (!existsSync(this.path)) return emptyState();
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      raw = null;
    }
    const file = raw && typeof raw === "object" ? (raw as { items?: unknown; runs?: unknown }) : null;
    const entries = file?.items && typeof file.items === "object" ? Object.entries(file.items) : [];
    const rawRuns = Array.isArray(file?.runs) ? file.runs : [];
    const items: Record<string, Item> = {};
    for (const [key, value] of entries) {
      const item = ItemSchema.safeParse(value);
      if (item.success) items[key] = item.data;
    }
    const runs = rawRuns.flatMap((value): Run[] => {
      const run = RunSchema.safeParse(value);
      return run.success ? [run.data] : [];
    });
    const dropped = !file || Object.keys(items).length < entries.length || runs.length < rawRuns.length;
    if (dropped) {
      const aside = `${this.path}.unreadable-${Date.now()}`;
      copyFileSync(this.path, aside);
      console.error(`inbox state: dropped what it couldn't read; the original is at ${aside}`);
    }
    return { items, runs };
  }

  save(state: State): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
