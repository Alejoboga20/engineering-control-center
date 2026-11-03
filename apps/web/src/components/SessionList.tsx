import type { SessionDto } from '@ecc/shared';
import type { ClaudeMonitorView } from '../services/claude-status';
import { SessionItem } from './SessionItem';

interface SessionListProps {
  sessions: SessionDto[] | null;
  loading: boolean;
  error: string | null;
  selected: string | null;
  monitor: ClaudeMonitorView;
  onSelect: (name: string) => void;
}

export function SessionList({
  sessions,
  loading,
  error,
  selected,
  monitor,
  onSelect,
}: SessionListProps) {
  if (loading && !sessions) {
    return <p className="px-2 py-1 text-xs text-muted">Loading sessions…</p>;
  }
  return (
    <>
      {error && (
        <p role="alert" className="mx-2 mb-2 rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">
          {error}
        </p>
      )}
      {sessions?.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted">No tmux sessions yet.</p>
      )}
      {sessions && sessions.length > 0 && (
        <ul aria-label="Sessions" className="space-y-0.5">
          {sessions.map((session) => (
            <SessionItem
              key={session.name}
              session={session}
              selected={session.name === selected}
              monitor={monitor}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </>
  );
}
