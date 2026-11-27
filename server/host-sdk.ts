/** One pull request as the host's PR service reads it. Mirrors `ChangeRequestRead` (fullstackhouse/paseo#285). */
export type HostChangeRequestRead =
  | {
      url: string;
      ok: true;
      number: number;
      title: string;
      state: "open" | "merged" | "closed";
      isDraft: boolean;
      checksState: "passing" | "failing" | "pending" | "none";
      headSha: string;
      /** Only for subscriptions that include "deployments"; newest first. */
      deployments?: { environment: string | null; state: string | null; createdAt: string; url?: string; logUrl?: string }[];
    }
  | { url: string; ok: false; error: string; reason?: "paused" | "not_found" | "unsupported" | "error"; retryAt?: number };

export interface HostSubscriptionTarget {
  urls?: string[];
  priority?: "visible" | "background";
  include?: "deployments"[];
}

export interface HostSubscriptionUpdate {
  results: HostChangeRequestRead[];
  branches: unknown[];
}

export interface HostSubscription {
  initial: HostSubscriptionUpdate;
  unsubscribe(): Promise<void>;
}

// COMPAT(changeRequestSubscriptions): FSH hosts from fullstackhouse/paseo#285 follow PRs for plugins with pushed
// updates. The npm client has no type for it; the plugin runs on the host's SDK, so `subscribe` is there exactly when
// the daemon serves it.
declare module "@getpaseo/client" {
  interface PaseoApi {
    readonly changeRequests?: {
      subscribe?(target: HostSubscriptionTarget, onUpdate: (update: HostSubscriptionUpdate) => void): Promise<HostSubscription>;
    };
  }
}
