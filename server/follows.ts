import type { PaseoApi } from "@getpaseo/client";
import type { Checks } from "../shared/inbox";
import { deployEntries, type DeployEntry } from "../shared/upstream";
import type { HostChangeRequestRead, HostSubscription } from "./host-sdk";

type Subscribe = NonNullable<NonNullable<PaseoApi["changeRequests"]>["subscribe"]>;
type Read = Extract<HostChangeRequestRead, { ok: true }>;

/** A review screen's PR nobody looked at for this long is unfollowed. */
export const VISIBLE_UNUSED_MS = 10 * 60_000;

interface Entry {
  subscription: Promise<HostSubscription | null>;
  usedAt: number;
  read: Read | null;
  priority: "visible" | "background";
  withDeployments: boolean;
}

/** What the host's PR service last said about a PR. */
export interface LivePr {
  checks: Checks;
  isDraft: boolean;
  headSha: string;
  state: Read["state"];
}

/**
 * Live state of the PRs the Inbox shows, from the host's PR service (`paseo.changeRequests.subscribe`,
 * fullstackhouse/paseo#285): the host reads each PR once for every subscriber in the daemon, at the pace it needs, and
 * pushes changes. Open runs' PRs are followed in the background for their checks; the review screen follows its PR as
 * visible with deployments. Search, files, threads and the timeline stay `gh` calls of the plugin's own.
 */
export class PrFollows {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly paseo: () => PaseoApi | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** True on hosts that follow PRs for plugins. */
  get available(): boolean {
    return Boolean(this.subscriber());
  }

  /** Each URL's live state, following any not followed yet; null for a PR the host hasn't read. */
  async live(urls: readonly string[]): Promise<Map<string, LivePr | null>> {
    await Promise.all(urls.map((url) => this.follow(url, "background", false)));
    return new Map(urls.map((url) => [url, liveOf(this.entries.get(url)?.read ?? null)]));
  }

  /** The PR's preview deployments as header entries, following it as visible; null on hosts without the service. */
  async deployments(url: string): Promise<DeployEntry[] | null> {
    if (!(await this.follow(url, "visible", true))) return null;
    const read = this.entries.get(url)?.read;
    return deployEntries(
      (read?.deployments ?? []).map((deployment) => ({
        environment: deployment.environment ?? "deployment",
        createdAt: deployment.createdAt,
        state: deployment.state,
        logUrl: deployment.logUrl ?? null,
        url: deployment.url ?? null,
      })),
    );
  }

  /** Stops following PRs outside `urls`, except a review screen's PR looked at in the last `VISIBLE_UNUSED_MS`. */
  async retain(urls: Iterable<string>): Promise<void> {
    const keep = new Set(urls);
    const done: Promise<unknown>[] = [];
    for (const [url, entry] of this.entries) {
      if (keep.has(url) || (entry.priority === "visible" && this.now() - entry.usedAt < VISIBLE_UNUSED_MS)) continue;
      this.entries.delete(url);
      done.push(entry.subscription.then((subscription) => subscription?.unsubscribe()).catch(() => undefined));
    }
    await Promise.all(done);
  }

  async close(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map((entry) => entry.subscription.then((subscription) => subscription?.unsubscribe()).catch(() => undefined)));
  }

  /** Follows `url`, upgrading an existing subscription that lacks the priority or deployments asked for. */
  private async follow(url: string, priority: Entry["priority"], withDeployments: boolean): Promise<boolean> {
    const subscribe = this.subscriber();
    if (!subscribe) return false;
    const existing = this.entries.get(url);
    if (existing && (existing.priority === "visible" || priority === "background") && (existing.withDeployments || !withDeployments)) {
      if (priority === "visible") existing.usedAt = this.now();
      await existing.subscription;
      return true;
    }
    const entry: Entry = { subscription: Promise.resolve(null), usedAt: this.now(), read: existing?.read ?? null, priority, withDeployments };
    entry.subscription = subscribe(
      { urls: [url], priority, ...(withDeployments ? { include: ["deployments" as const] } : {}) },
      (update) => {
        const read = update.results.find((result) => result.url === url);
        if (read?.ok) entry.read = read;
      },
    ).then(
      (subscription) => {
        const read = subscription.initial.results[0];
        if (read?.ok) entry.read = read;
        return subscription;
      },
      (error: unknown) => {
        if (this.entries.get(url) === entry) this.entries.delete(url);
        console.error(`[inbox] following ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      },
    );
    this.entries.set(url, entry);
    const followed = Boolean(await entry.subscription);
    // The new subscription replaces the old one once it's in place.
    if (existing) await existing.subscription.then((subscription) => subscription?.unsubscribe()).catch(() => undefined);
    return followed;
  }

  private subscriber(): Subscribe | null {
    const changeRequests = this.paseo()?.changeRequests;
    // COMPAT(changeRequestSubscriptions): hosts before fullstackhouse/paseo#285 have no subscribe.
    return changeRequests?.subscribe ? changeRequests.subscribe.bind(changeRequests) : null;
  }
}

function liveOf(read: Read | null): LivePr | null {
  return read ? { checks: read.checksState, isDraft: read.isDraft, headSha: read.headSha, state: read.state } : null;
}
