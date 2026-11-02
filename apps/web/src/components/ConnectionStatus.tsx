import type { TerminalStatus } from '../hooks/useTerminal';

const PRESENTATION: Record<TerminalStatus, { label: string; dot: string }> = {
  connecting: { label: 'Connecting', dot: 'bg-yellow-400 animate-pulse' },
  connected: { label: 'Connected', dot: 'bg-green-400' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-yellow-400 animate-pulse' },
  disconnected: { label: 'Disconnected', dot: 'bg-red-400' },
  busy: { label: 'In use elsewhere', dot: 'bg-orange-400' },
  ended: { label: 'Session ended', dot: 'bg-neutral-500' },
};

export function ConnectionStatus({ status }: { status: TerminalStatus }) {
  const { label, dot } = PRESENTATION[status];
  return (
    <span role="status" className="flex items-center gap-1.5 text-xs text-muted">
      <span aria-hidden className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
