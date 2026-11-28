import { describe, expect, it } from "vitest";
import { INSTRUCTIONS } from "../shared/review";

describe("reviewer instructions", () => {
  const summary = INSTRUCTIONS.slice(INSTRUCTIONS.indexOf("summary (markdown)"), INSTRUCTIONS.indexOf("reasoning (markdown)"));

  it("lists the house PR format's sections in order, 📦 usage, 🧭 impact and ✅ testing included", () => {
    const order = ["🎯", "🔧", "📦", "🧭", "🧩", "🔍", "✅", "⚠️"].map((emoji) => summary.indexOf(emoji));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("asks for a labelled flowchart TD diagram, reusing the PR's own", () => {
    expect(summary).toContain("`flowchart TD`");
    expect(summary).toMatch(/arrow labelled/);
    expect(summary).toMatch(/reuse it/);
  });
});
