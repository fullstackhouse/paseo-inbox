import type { ReactNode } from "react";
import "@getpaseo/plugin/client/ui";

// COMPAT(markdown-annotations): added in Paseo v0.15.3 FSH; remove after SDK publication (2026-12-10).
declare module "@getpaseo/plugin/client/ui" {
  interface MarkdownProps {
    compact?: boolean;
    afterBlock?: (block: { startLine: number; endLine: number }) => ReactNode;
  }
}
