import {
  CLAUDE_EVENTS_PATH,
  type ClaudeMonitorMessage,
  type ClaudeSessionStatus,
  type ClaudeState,
} from '@ecc/shared';

/** What the browser knows. Nothing is kept while disconnected, so nothing stale can be shown. */
export interface ClaudeMonitorView {
  connected: boolean;
  ingestionAvailable: boolean;
  statuses: Record<string, ClaudeSessionStatus>;
}

export const CLAUDE_STATE_PRESENTATION: Record<
  ClaudeState,
  { label: string; icon: string; className: string }
> = {
  working: { label: 'Working', icon: '●', className: 'text-blue-400' },
  needs_attention: { label: 'Needs Attention', icon: '▲', className: 'text-amber-400' },
  idle: { label: 'Idle', icon: '●', className: 'text-neutral-300' },
  offline: { label: 'Offline', icon: '○', className: 'text-neutral-500' },
  unknown: { label: 'Unknown', icon: '?', className: 'text-neutral-400' },
};

export function claudeEventsUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${CLAUDE_EVENTS_PATH}`;
}

export function parseMonitorMessage(raw: unknown): ClaudeMonitorMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const message = JSON.parse(raw) as Partial<ClaudeMonitorMessage>;
    return message.type === 'claude.status.snapshot' || message.type === 'claude.status.changed'
      ? (message as ClaudeMonitorMessage)
      : null;
  } catch {
    return null;
  }
}

/** A session with no entry has simply produced no events, so it is Unknown, never assumed idle. */
export function claudeStatusOf(view: ClaudeMonitorView, session: string): ClaudeSessionStatus {
  return (
    view.statuses[session] ?? {
      tmuxSession: session,
      state: 'unknown',
      monitored: false,
      reason: 'no-events',
      instanceCount: 0,
    }
  );
}

/** A sentence qualifying the state, for those that need one. */
export function explainClaudeStatus(
  view: ClaudeMonitorView,
  status: ClaudeSessionStatus,
): string | null {
  if (!view.connected) return 'The live connection to the server was lost. Reconnecting.';
  if (!view.ingestionAvailable) {
    return 'The server could not prepare its hook credentials. See its log.';
  }
  if (status.reason === 'multiple-instances') {
    return `${status.instanceCount} Claude Code instances are live in this session, so one state cannot describe them.`;
  }
  switch (status.state) {
    case 'needs_attention':
      return 'Claude Code asked for permission or input. It may already be resolved: denying a request sends no event, so this clears on the next prompt.';
    case 'unknown':
      if (status.reason === 'stale') {
        return 'No event for a while, so the last known state is no longer reliable. An interrupted or killed Claude Code sends no event.';
      }
      if (status.reason === 'insufficient-events') {
        return 'Claude Code was seen, but its events do not establish a state yet.';
      }
      return `No events received. Claude Code may not be running, hooks may not be installed, or the session may predate monitoring. To monitor it, start Claude Code with: ECC_TMUX_SESSION=${status.tmuxSession} claude`;
    default:
      return null;
  }
}
