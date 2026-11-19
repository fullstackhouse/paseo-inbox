import { describe, expect, it } from "vitest";
import { ago, agoText } from "../shared/ago";

const now = Date.parse("2026-01-10T12:00:00Z");
const before = (ms: number) => new Date(now - ms).toISOString();

describe("ago", () => {
  it("is compact for columns", () => {
    expect(ago(before(10_000), now)).toBe("now");
    expect(ago(before(5 * 60_000), now)).toBe("5m");
    expect(ago(before(3 * 3_600_000), now)).toBe("3h");
    expect(ago(before(3 * 86_400_000), now)).toBe("3d");
  });
  it("reads as a phrase in sentences, never \"now ago\"", () => {
    expect(agoText(before(10_000), now)).toBe("just now");
    expect(agoText(before(5 * 60_000), now)).toBe("5m ago");
  });
});
