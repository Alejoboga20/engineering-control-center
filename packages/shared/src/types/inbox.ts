/**
 * Engineering Inbox: a persistent, prioritized queue of work that needs a human.
 * An event is something that happened. An item is something that needs attention. Many events
 * update one item, which is found by its stable `sourceKey`. Documented in docs/engineering-inbox.md.
 */

export const INBOX_ITEM_TYPES = [
  'pull_request',
  'human_input',
  'permission_request',
  'agent_failure',
] as const;
export type InboxItemType = (typeof INBOX_ITEM_TYPES)[number];

export const INBOX_PRIORITIES = ['P1', 'P2', 'P3'] as const;
export type InboxPriority = (typeof INBOX_PRIORITIES)[number];

export const INBOX_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export type InboxSource = 'github' | 'claude' | 'manual';

/**
 * What the source says now, independent of the human status.
 * - Pull requests: `open`, `merged`, `closed`.
 * - Claude items: `pending` (the condition was reported and not yet cleared), `cleared` (a later
 *   reliable event ended it), `uncertain` (nothing reliable says whether it is still pending, for
 *   example after a backend restart or once the tmux session is gone).
 */
export type InboxSourceState = 'open' | 'merged' | 'closed' | 'pending' | 'cleared' | 'uncertain';

/** How an item was resolved. `auto_*` values are set by synchronization, never by a person. */
export type InboxResolution = 'manual' | 'auto_merged' | 'auto_closed' | 'auto_cleared';

/** `agent_reported` only when an authenticated agent report named this pull request. */
export type PullRequestAttribution = 'discovered' | 'agent_reported';

export type PullRequestReviewState =
  | 'review_required'
  | 'approved'
  | 'changes_requested'
  | 'none'
  | 'unknown';

export type PullRequestChecksState = 'passing' | 'failing' | 'pending' | 'none' | 'unknown';

export interface InboxPullRequest {
  /** `owner/name`, lower case. */
  repository: string;
  number: number;
  url: string;
  author: string | null;
  draft: boolean;
  reviewState: PullRequestReviewState;
  checksState: PullRequestChecksState;
  attribution: PullRequestAttribution;
}

export interface InboxItem {
  id: string;
  type: InboxItemType;
  /** Plain text from untrusted sources. Never render as HTML. */
  title: string;
  description: string | null;
  /** The effective priority. */
  priority: InboxPriority;
  /** What the source rules suggest. Equal to `priority` unless a person overrode it. */
  suggestedPriority: InboxPriority;
  priorityOverridden: boolean;
  status: InboxStatus;
  source: InboxSource;
  sourceState: InboxSourceState;
  /** tmux session name, when known. The session may no longer exist. */
  sourceSession: string | null;
  /** Claude Code session ID, or a subagent ID, when known. */
  sourceAgent: string | null;
  pullRequest: InboxPullRequest | null;
  /** Increases with every change, so clients can drop updates older than what they hold. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** The last event that concerned this item. Sorting uses it. */
  lastActivityAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolution: InboxResolution | null;
}

export interface InboxEvent {
  id: string;
  itemId: string | null;
  /** For example `pr.discovered`, `pr.checks_failed`, `permission.requested`, `item.acknowledged`. */
  kind: string;
  source: InboxSource | 'human' | 'system';
  /** Safe, allowlisted metadata only. Never prompts, tool arguments or tokens. */
  summary: string;
  occurredAt: string;
  recordedAt: string;
}

export interface InboxItemDetail {
  item: InboxItem;
  /** Newest first, bounded. */
  events: InboxEvent[];
}

export type InboxFilter = 'all' | 'needs_attention' | 'pull_requests' | 'agent_blockers' | 'resolved';

export interface InboxListQuery {
  filter?: InboxFilter;
  priority?: InboxPriority;
  status?: InboxStatus;
}

export interface InboxListResponse {
  /** Sorted: priority, then actionability, then most recent activity. */
  items: InboxItem[];
}

export interface GitHubRepositorySyncStatus {
  repository: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface GitHubSyncStatus {
  /** False when no repositories or no token are configured. Nothing is polled then. */
  configured: boolean;
  /** Why it is not configured, or null. */
  configurationProblem: string | null;
  running: boolean;
  pollIntervalSeconds: number;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** Set while backing off from a GitHub rate limit. */
  rateLimitedUntil: string | null;
  repositories: GitHubRepositorySyncStatus[];
}

export interface InboxSummary {
  open: number;
  /** Open items with priority P1. */
  needsAttention: number;
  /** Open or acknowledged pull request items whose PR is open and not a draft. */
  pullRequestsAwaitingReview: number;
  acknowledged: number;
  github: GitHubSyncStatus;
  /** False when the backend could not prepare agent reporting credentials. */
  agentReportingAvailable: boolean;
}

/** `priority: null` clears a manual override, returning to the suggested priority. */
export interface UpdateInboxItemRequest {
  priority: InboxPriority | null;
}

/** What an authenticated agent may report. Everything is validated and length-limited. */
export interface AgentReportRequest {
  type: 'human_input' | 'pull_request';
  /** Same key, same report: retries never create a second item. 8-128 of [A-Za-z0-9_.:-]. */
  idempotencyKey?: string;
  /** human_input: required, 1-200 characters. */
  title?: string;
  /** human_input: up to 4000 characters. */
  description?: string;
  /** human_input: defaults to P2. */
  priority?: InboxPriority;
  /** tmux session name, verified by the reporter against tmux. */
  sourceSession?: string;
  /** Claude Code session ID, when the reporter knows it. */
  sourceAgent?: string;
  /** pull_request: `owner/name`, which must be an allowed repository. */
  repository?: string;
  /** pull_request: the PR number. GitHub remains the source of truth for its state. */
  pullRequestNumber?: number;
}

export interface AgentReportResponse {
  itemId: string;
  /** False when an existing item was updated or the report was a retry. */
  created: boolean;
}

export type InboxMessage =
  | { type: 'inbox.item.created'; data: InboxItem }
  | { type: 'inbox.item.updated'; data: InboxItem }
  | { type: 'inbox.item.resolved'; data: InboxItem }
  | { type: 'inbox.sync.completed'; data: GitHubSyncStatus }
  /** Sent first on every connection. The client must then fetch `GET /api/inbox`. */
  | { type: 'inbox.hello'; data: { serverTime: string } };

export const INBOX_STREAM_PATH = '/api/inbox/stream';

export const INBOX_LIMITS = {
  titleMax: 200,
  descriptionMax: 4000,
  idempotencyKeyPattern: /^[A-Za-z0-9_.:-]{8,128}$/,
  repositoryPattern: /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/,
  eventsPerItem: 200,
  eventsInDetail: 100,
} as const;
