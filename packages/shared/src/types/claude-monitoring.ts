/**
 * Claude Code lifecycle monitoring. States are observations from hook events, not guarantees.
 * Documented in docs/claude-monitoring.md.
 */

/** Hook events the reporter forwards. `scripts/claude-hooks.cjs` must register the same list. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

export type ClaudeHookEventType = (typeof CLAUDE_HOOK_EVENTS)[number];

export type ClaudeState = 'working' | 'needs_attention' | 'idle' | 'offline' | 'unknown';

/**
 * Why a status needs qualifying.
 * - `no-events`: nothing has been reported for this session since the backend started.
 * - `insufficient-events`: Claude was seen, but its events do not establish a state yet.
 * - `stale`: the last event is too old to rely on.
 * - `multiple-instances`: several Claude instances are live, so no single state describes them.
 */
export type ClaudeStatusReason =
  | 'no-events'
  | 'insufficient-events'
  | 'stale'
  | 'multiple-instances';

/** Metadata only. The API rejects any other field, so content cannot be stored by accident. */
export interface ClaudeHookEventRequest {
  eventId: string;
  claudeSessionId: string;
  tmuxSession: string;
  eventType: ClaudeHookEventType;
  /** When the hook ran, as an ISO 8601 string. Orders events that arrive out of order. */
  timestamp: string;
  /** tmux pane ID. Tells a restart in the same pane from a second Claude in another pane. */
  pane?: string;
  /** SessionStart only. */
  source?: string;
  /** Notification only. */
  notificationType?: string;
  /** Tool name, never its arguments. Matches a completed tool to its permission request. */
  toolName?: string;
  /** Set when a subagent, rather than the main conversation, raised the event. */
  agentId?: string;
}

export interface ClaudeHookEventResponse {
  accepted: boolean;
}

export interface ClaudeSessionStatus {
  tmuxSession: string;
  state: ClaudeState;
  /** True once any event has been received for this session since the backend started. */
  monitored: boolean;
  reason: ClaudeStatusReason | null;
  /** Live instances seen in this session. More than 1 means the state is not one-to-one. */
  instanceCount: number;
  claudeSessionId?: string;
  lastEvent?: ClaudeHookEventType;
  lastEventAt?: string;
  lastActivityAt?: string;
}

export interface ClaudeStatusResponse {
  /** False when the backend could not prepare hook credentials, so no event can be accepted. */
  ingestionAvailable: boolean;
  sessions: ClaudeSessionStatus[];
}

/** Sent by `WS /api/claude/events`, which accepts no messages from clients. */
export type ClaudeMonitorMessage =
  /** Always the first message on a connection, so reconnecting replaces everything known. */
  | { type: 'claude.status.snapshot'; data: ClaudeStatusResponse }
  | { type: 'claude.status.changed'; data: ClaudeSessionStatus };

export const CLAUDE_EVENTS_PATH = '/api/claude/events';
