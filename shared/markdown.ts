/** The new-side text of an added file, rebuilt from its patch (one hunk starting at line 1). */
export function addedText(patch: string | undefined): string | null {
  if (!patch || !/^@@ -0,0 \+1/.test(patch)) return null;
  return patch
    .split("\n")
    .slice(1)
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
}

export const isMarkdownPath = (path: string) => /\.(md|mdx|markdown)$/i.test(path);
