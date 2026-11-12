import type { ComponentType, ReactNode } from "react";
import "@getpaseo/plugin/client/ui";

// COMPAT(pull-request-panel): Paseo v0.15.3 FSH; remove after SDK publication (2026-12-10).
// Mirrors packages/plugin/src/client/ui.ts in fullstackhouse/paseo.
declare module "@getpaseo/plugin/client/ui" {
  interface PullRequestPanelCheck {
    name: string;
    status: "success" | "failure" | "pending" | "skipped" | "cancelled";
    url: string;
    workflow?: string;
    timing?: string;
  }

  interface PullRequestPanelActivity {
    /** Unique across this pull request's reviews and comments. */
    id: string;
    kind: "review" | "comment";
    author: string;
    authorUrl?: string | null;
    avatarUrl?: string | null;
    body: string;
    url: string;
    /** ISO timestamp; the host orders activity and formats its age. */
    createdAt: string;
    reviewState?: "approved" | "changes_requested" | "commented";
    /** Matches the parent review's activity id to nest this comment's thread. */
    reviewId?: string;
    threadId?: string;
    threadIsResolved?: boolean;
    location?: {
      path: string;
      line?: number;
      startLine?: number;
      threadId?: string;
      isResolved?: boolean;
      isOutdated?: boolean;
    };
  }

  interface PullRequestPanelData {
    /** Forge id, such as "github" or "gitlab". Unknown ids use neutral labels. */
    forge: string;
    number: number;
    title: string;
    url: string;
    state: "open" | "draft" | "merged" | "closed";
    repoOwner?: string;
    repoName?: string;
    checks: PullRequestPanelCheck[];
    activity: PullRequestPanelActivity[];
  }

  interface PullRequestPanelProps {
    data: PullRequestPanelData;
    activityLoading?: boolean;
    onRefresh?: () => void;
    isRefreshing?: boolean;
    /** Default true. Set false inside a parent scroll view. */
    scrollable?: boolean;
    /** Default true. Hide when the parent already names the pull request. */
    showHeader?: boolean;
    /** Optional freshness or commit label beside the shared toolbar actions. */
    toolbarMeta?: ReactNode;
  }

  /** The Explorer's checks and activity UI with plugin-supplied data; no workspace or writes. */
  const PullRequestPanel: ComponentType<PullRequestPanelProps>;
}

export type { PullRequestPanelData } from "@getpaseo/plugin/client/ui";
