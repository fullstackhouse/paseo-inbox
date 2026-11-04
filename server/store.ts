import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, emptyState, StateSchema, type Config, type State } from "../shared/inbox";

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

  load(): State {
    if (!existsSync(this.path)) return emptyState();
    const parsed = StateSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
    return parsed.success ? parsed.data : emptyState();
  }

  save(state: State): void {
    writeFileSync(`${this.path}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
  }
}
