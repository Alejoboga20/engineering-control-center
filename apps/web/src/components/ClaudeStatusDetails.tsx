import { claudeStatusOf, explainClaudeStatus, type ClaudeMonitorView } from '../services/claude-status';
import { formatAge } from '../services/format';
import { ClaudeStatusBadge } from './ClaudeStatusBadge';

interface ClaudeStatusDetailsProps {
  session: string;
  monitor: ClaudeMonitorView;
}

export function ClaudeStatusDetails({ session, monitor }: ClaudeStatusDetailsProps) {
  const status = claudeStatusOf(monitor, session);
  const explanation = explainClaudeStatus(monitor, status);
  // One line of fixed height. If this strip grew when the state changed, the terminal below would
  // resize and the program in it would redraw, every time.
  return (
    <div
      aria-label="Claude Code status"
      className="flex h-6 shrink-0 items-center gap-x-3 overflow-hidden border-b border-line px-4 text-xs whitespace-nowrap text-muted"
    >
      <span>Claude Code</span>
      <ClaudeStatusBadge state={status.state} />
      <span>Monitoring: {monitor.connected && status.monitored ? 'active' : 'not available'}</span>
      {status.lastEvent && <span>Last event: {status.lastEvent}</span>}
      {status.lastActivityAt && <span>Last activity: {formatAge(status.lastActivityAt)}</span>}
      {explanation && (
        <p title={explanation} className="min-w-0 flex-1 truncate">
          {explanation}
        </p>
      )}
    </div>
  );
}
