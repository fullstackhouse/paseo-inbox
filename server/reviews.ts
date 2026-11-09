import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReviewDraftSchema, type ReviewDraft } from "../shared/review";

/** Review drafts, one JSON file per run (`<owner>__<repo>__<number>@<sha>__<rule>.json`). */
export class ReviewStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "reviews");
    mkdirSync(this.dir, { recursive: true });
  }

  get(runId: string): ReviewDraft | null {
    const path = this.path(runId);
    if (!existsSync(path)) return null;
    const parsed = ReviewDraftSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  }

  has(runId: string): boolean {
    return existsSync(this.path(runId));
  }

  save(draft: ReviewDraft): void {
    const path = this.path(draft.runId);
    writeFileSync(`${path}.tmp`, JSON.stringify(draft, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  private path(runId: string): string {
    // runId is `owner/repo#123|rule|sha`, plus `|r2` for a later round at the same head.
    const [item = "", rule = "", sha = "", round] = runId.split("|");
    const safe = `${item.replace(/[/#]/g, "__")}@${sha}__${rule}${round ? `__${round}` : ""}`.replace(/[^\w@.-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }
}
