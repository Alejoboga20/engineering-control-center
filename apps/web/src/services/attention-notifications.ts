import type { ClaudeMonitorView } from './claude-status';

export const BASE_TITLE = 'Engineering Control Center';

const PREFERENCE_KEY = 'ecc.attention-notifications';

/** Empty while disconnected, since nothing is known then. */
export function sessionsNeedingAttention(view: ClaudeMonitorView): Set<string> {
  if (!view.connected) return new Set();
  return new Set(
    Object.values(view.statuses)
      .filter((status) => status.state === 'needs_attention')
      .map((status) => status.tmuxSession),
  );
}

export function attentionTitle(count: number): string {
  return count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

export interface AttentionChange {
  current: Set<string>;
  entered: string[];
  left: string[];
}

/**
 * Compares what the server now reports with what was last known. Returns null while disconnected,
 * so that a session which started needing attention during an outage is still announced after it.
 * The first report sets the baseline: opening the page announces nothing, and the title has the count.
 */
export function advanceAttention(
  known: ReadonlySet<string> | null,
  view: ClaudeMonitorView,
): AttentionChange | null {
  if (!view.connected) return null;
  const current = sessionsNeedingAttention(view);
  if (!known) return { current, entered: [], left: [] };
  return {
    current,
    entered: [...current].filter((session) => !known.has(session)),
    left: [...known].filter((session) => !current.has(session)),
  };
}

export type NotificationAvailability = 'insecure' | 'unsupported' | NotificationPermission;

export function notificationAvailability(): NotificationAvailability {
  // Checked first, because some browsers define the API on insecure pages and then refuse it.
  if (!window.isSecureContext) return 'insecure';
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** Storage can throw or come back empty, in which case notifications are simply off. */
export function readNotificationPreference(): boolean {
  try {
    return window.localStorage.getItem(PREFERENCE_KEY) === 'on';
  } catch {
    return false;
  }
}

export function writeNotificationPreference(on: boolean): void {
  try {
    window.localStorage.setItem(PREFERENCE_KEY, on ? 'on' : 'off');
  } catch {
    // The choice then lasts only until the page is reloaded.
  }
}

/**
 * The tag makes the browser replace, not stack, alerts for one session, including those from other
 * tabs. Only the session name is included, because the notification can appear on a lock screen.
 */
export function showAttentionNotification(session: string): Notification {
  return new Notification(`${session} needs attention`, {
    body: 'Claude Code asked for permission or input.',
    tag: `ecc-attention-${session}`,
    requireInteraction: true,
  });
}

export function showConfirmationNotification(): Notification {
  return new Notification('Notifications are on', {
    body: 'You will be alerted when a session needs attention, while this page stays open.',
    tag: 'ecc-attention-confirmation',
  });
}
