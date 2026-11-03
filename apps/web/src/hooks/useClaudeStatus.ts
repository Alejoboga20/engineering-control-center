import { useEffect, useState } from 'react';
import {
  claudeEventsUrl,
  parseMonitorMessage,
  type ClaudeMonitorView,
} from '../services/claude-status';

export const CLAUDE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

const DISCONNECTED: ClaudeMonitorView = {
  connected: false,
  ingestionAvailable: true,
  statuses: {},
};

/**
 * Live Claude status for every session. Each connection starts with a full snapshot from the
 * server, which replaces everything known, so a restart or a missed change cannot linger.
 */
export function useClaudeStatus(): ClaudeMonitorView {
  const [view, setView] = useState<ClaudeMonitorView>(DISCONNECTED);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let disposed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const ws = new WebSocket(claudeEventsUrl());
      socket = ws;

      ws.onmessage = (event: MessageEvent<unknown>) => {
        const message = parseMonitorMessage(event.data);
        if (message?.type === 'claude.status.snapshot') {
          attempts = 0;
          setView({
            connected: true,
            ingestionAvailable: message.data.ingestionAvailable,
            statuses: Object.fromEntries(
              message.data.sessions.map((status) => [status.tmuxSession, status]),
            ),
          });
        } else if (message?.type === 'claude.status.changed') {
          setView((current) => ({
            ...current,
            statuses: { ...current.statuses, [message.data.tmuxSession]: message.data },
          }));
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setView(DISCONNECTED);
        const delay = CLAUDE_RETRY_DELAYS_MS[Math.min(attempts, CLAUDE_RETRY_DELAYS_MS.length - 1)];
        attempts++;
        timer = setTimeout(connect, delay);
      };
    }

    // Deferred so that React StrictMode's first, immediately discarded mount opens no socket.
    timer = setTimeout(connect, 0);

    return () => {
      disposed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return view;
}
