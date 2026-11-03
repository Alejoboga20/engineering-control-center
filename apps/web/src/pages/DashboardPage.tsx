import type { SessionDto } from '@ecc/shared';
import { TerminalView } from '../components/TerminalView';
import type { ClaudeMonitorView } from '../services/claude-status';

interface DashboardPageProps {
  selected: string | null;
  sessions: SessionDto[] | null;
  monitor: ClaudeMonitorView;
  onCreate: () => void;
  onTerminate: (session: string) => void;
  onSessionEnded: () => void;
}

export function DashboardPage(props: DashboardPageProps) {
  if (!props.selected) {
    const empty = props.sessions?.length === 0;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-muted">
          {empty ? 'No sessions are running.' : 'Select a session to open its terminal.'}
        </p>
        {empty && (
          <button
            type="button"
            onClick={props.onCreate}
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface"
          >
            Create a session
          </button>
        )}
      </div>
    );
  }
  // The key gives each session its own terminal instance and scrollback.
  return (
    <TerminalView
      key={props.selected}
      session={props.selected}
      monitor={props.monitor}
      onTerminate={props.onTerminate}
      onSessionEnded={props.onSessionEnded}
    />
  );
}
