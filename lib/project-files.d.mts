import type { GithubClient } from "./github.mjs";

export function classifyRef(ref: string): {
  ok: boolean;
  reason?: string;
  kind?: "pull" | "commit" | "branch";
  pullNumber?: number;
  sha?: string;
  branch?: string;
};

export interface ProjectLoad {
  denied: boolean;
  fetch: boolean;
  stop: boolean;
  reason?: string;
  sha?: string;
  project?: Record<string, any>;
  projectYaml?: string;
  files?: Record<string, string>;
  documentPath?: string;
  documentText?: string;
  sha256?: string;
  mergeCommit?: string;
  torPath?: string;
  torText?: string;
  torSha256?: string;
  torMergeCommit?: string;
  srsPath?: string;
  srsText?: string;
  srsSha256?: string;
  srsMergeCommit?: string;
}

export function loadProjectFiles(
  client: GithubClient,
  input: {
    projectId: string;
    ref: string;
    userId: string | null;
    allowedUserIds: readonly string[];
  },
): Promise<ProjectLoad>;

export function loadApprovedDocument(
  client: GithubClient,
  input: {
    projectId: string;
    block: string;
    userId: string | null;
    allowedUserIds: readonly string[];
    headRef?: string;
  },
): Promise<ProjectLoad>;

export function loadApprovedPlan(
  client: GithubClient,
  input: {
    projectId: string;
    userId: string | null;
    allowedUserIds: readonly string[];
    headRef?: string;
    ref?: string;
  },
): Promise<ProjectLoad & { paused?: boolean }>;

export function loadApprovedTor(
  client: GithubClient,
  input: {
    projectId: string;
    userId: string | null;
    allowedUserIds: readonly string[];
    headRef?: string;
  },
): Promise<ProjectLoad>;

export function loadApprovedSrs(
  client: GithubClient,
  input: {
    projectId: string;
    userId: string | null;
    allowedUserIds: readonly string[];
    headRef?: string;
  },
): Promise<ProjectLoad>;

export function loadChangeControlSources(
  client: GithubClient,
  input: {
    projectId: string;
    userId: string | null;
    allowedUserIds: readonly string[];
    headRef?: string;
  },
): Promise<ProjectLoad>;
