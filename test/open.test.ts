import { describe, expect, it, vi } from "vitest";
import { openInBrowser } from "../server/open";

describe("openInBrowser", () => {
  it("uses the platform's opener and refuses non-http links", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "" }));
    await openInBrowser("https://github.com/a/b/pull/1", "darwin", run as never);
    await openInBrowser("https://x", "linux", run as never);
    expect(run.mock.calls).toEqual([["open", ["https://github.com/a/b/pull/1"]], ["xdg-open", ["https://x"]]]);
    await expect(openInBrowser("file:///etc/passwd", "darwin", run as never)).rejects.toThrow("Only http(s) links");
  });
});
