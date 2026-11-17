import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../server/store";
import { emptyState, plan } from "../shared/inbox";
import { config, NOW, pr } from "./fixtures";

const dir = () => mkdtempSync(join(tmpdir(), "inbox-store-"));

describe("StateStore", () => {
  it("keeps the runs and items it can read when one run has a state it doesn't know", () => {
    const home = dir();
    const state = plan({ config: config(), results: { review: [pr({ number: 1 }), pr({ number: 2 })] }, state: emptyState(), now: NOW });
    const file = { ...state, runs: state.runs.map((run, index) => (index === 0 ? { ...run, state: "from-a-newer-build" } : run)) };
    writeFileSync(join(home, "state.json"), JSON.stringify(file));
    const loaded = new StateStore(home).load();
    expect(loaded.runs.map((run) => run.itemKey)).toEqual(["acme/shop#2"]);
    expect(Object.keys(loaded.items).sort()).toEqual(["acme/shop#1", "acme/shop#2"]);
    expect(readdirSync(home).filter((name) => name.startsWith("state.json.unreadable-"))).toHaveLength(1);
  });

  it("copies a file it can't read aside before starting empty, so a save doesn't destroy it", () => {
    const home = dir();
    writeFileSync(join(home, "state.json"), "{ not json");
    const store = new StateStore(home);
    expect(store.load()).toEqual(emptyState());
    store.save(emptyState());
    const kept = readdirSync(home).filter((name) => name.startsWith("state.json.unreadable-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(home, kept[0]!), "utf8")).toBe("{ not json");
  });

  it("starts empty without a file", () => {
    const home = dir();
    expect(new StateStore(home).load()).toEqual(emptyState());
    expect(existsSync(join(home, "state.json"))).toBe(false);
  });
});
