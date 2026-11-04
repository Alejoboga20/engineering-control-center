import { useCallback, useEffect, useRef, useState } from 'react';
import {
  advanceAttention,
  attentionTitle,
  BASE_TITLE,
  notificationAvailability,
  readNotificationPreference,
  sessionsNeedingAttention,
  showAttentionNotification,
  showConfirmationNotification,
  writeNotificationPreference,
  type NotificationAvailability,
} from '../services/attention-notifications';
import type { ClaudeMonitorView } from '../services/claude-status';

export interface AttentionNotificationControl {
  on: boolean;
  /** Waiting for the browser's permission prompt. */
  busy: boolean;
  /** Why notifications cannot be turned on, if they cannot. */
  unavailableReason: string | null;
  toggle: () => void;
}

interface Options {
  monitor: ClaudeMonitorView;
  /** The session on screen, if any. */
  viewing: string | null;
  onOpen: (session: string) => void;
}

function unavailableReason(availability: NotificationAvailability, failed: boolean): string | null {
  if (availability === 'insecure') return 'Notifications need HTTPS or localhost.';
  if (availability === 'unsupported') return 'This browser cannot show notifications.';
  if (availability === 'denied') return 'Notifications are blocked in this site’s browser settings.';
  // Android browsers grant the permission and then allow notifications only from an installed app.
  if (failed) return 'This browser refused to show a notification.';
  return null;
}

/**
 * Keeps the page title's count current, and announces each session that starts needing attention.
 * Nothing is sent to Claude Code: an alert only brings you to the session.
 */
export function useAttentionNotifications({
  monitor,
  viewing,
  onOpen,
}: Options): AttentionNotificationControl {
  const [enabled, setEnabled] = useState(readNotificationPreference);
  const [availability, setAvailability] = useState(notificationAvailability);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const on = enabled && availability === 'granted' && !failed;

  const known = useRef<ReadonlySet<string> | null>(null);
  const open = useRef(new Map<string, Notification>());
  const latest = useRef({ on, viewing, onOpen });

  useEffect(() => {
    latest.current = { on, viewing, onOpen };
  }, [on, viewing, onOpen]);

  const attentionCount = sessionsNeedingAttention(monitor).size;

  useEffect(() => {
    document.title = attentionTitle(attentionCount);
    return () => {
      document.title = BASE_TITLE;
    };
  }, [attentionCount]);

  useEffect(() => {
    const change = advanceAttention(known.current, monitor);
    if (!change) return;
    known.current = change.current;

    for (const session of change.left) {
      open.current.get(session)?.close();
      open.current.delete(session);
    }

    if (!latest.current.on) return;
    for (const session of change.entered) {
      const looking =
        session === latest.current.viewing &&
        document.visibilityState === 'visible' &&
        document.hasFocus();
      if (looking) continue;
      try {
        const notification = showAttentionNotification(session);
        notification.onclick = () => {
          window.focus();
          notification.close();
          open.current.delete(session);
          latest.current.onOpen(session);
        };
        open.current.set(session, notification);
      } catch {
        setFailed(true);
      }
    }
  }, [monitor]);

  const closeAll = useCallback(() => {
    for (const notification of open.current.values()) notification.close();
    open.current.clear();
  }, []);

  useEffect(() => closeAll, [closeAll]);

  // The permission can change in the browser's settings at any time, with no event in every browser.
  useEffect(() => {
    const refresh = () => setAvailability(notificationAvailability());
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  const toggle = useCallback(async () => {
    if (on) {
      closeAll();
      setEnabled(false);
      writeNotificationPreference(false);
      return;
    }
    if (notificationAvailability() === 'insecure') return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      setAvailability(permission);
      if (permission !== 'granted') return;
      showConfirmationNotification();
      setFailed(false);
      setEnabled(true);
      writeNotificationPreference(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [on, closeAll]);

  return {
    on,
    busy,
    unavailableReason: unavailableReason(availability, failed),
    toggle: () => void toggle(),
  };
}
