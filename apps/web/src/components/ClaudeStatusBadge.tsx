import type { ClaudeState } from '@ecc/shared';
import { CLAUDE_STATE_PRESENTATION } from '../services/claude-status';

/** Always shows text with its icon, so that the state never depends on color alone. */
export function ClaudeStatusBadge({ state }: { state: ClaudeState }) {
  const { label, icon, className } = CLAUDE_STATE_PRESENTATION[state];
  return (
    <span data-testid="claude-state" className={`flex shrink-0 items-center gap-1 ${className}`}>
      <span aria-hidden className={state === 'working' ? 'animate-pulse' : undefined}>
        {icon}
      </span>
      {label}
    </span>
  );
}
