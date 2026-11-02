import { useRef } from 'react';
import { useTerminal } from '../hooks/useTerminal';
import { ConnectionStatus } from './ConnectionStatus';

interface TerminalViewProps {
  session: string;
  onTerminate: (session: string) => void;
  onSessionEnded: () => void;
}

const BUTTON_CLASS = 'rounded border border-line px-2 py-0.5 text-xs hover:border-muted';

export function TerminalView({ session, onTerminate, onSessionEnded }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { status, message, reconnect, disconnect } = useTerminal(
    session,
    containerRef,
    onSessionEnded,
  );
  const canReconnect = status === 'disconnected' || status === 'busy';

  return (
    <section aria-label={`Terminal for ${session}`} className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5">
        <h2 className="truncate font-mono text-[13px] font-medium">{session}</h2>
        <ConnectionStatus status={status} />
        <div className="ml-auto flex gap-2">
          {canReconnect && (
            <button type="button" onClick={reconnect} className={BUTTON_CLASS}>
              Reconnect
            </button>
          )}
          {status === 'connected' && (
            <button type="button" onClick={disconnect} className={BUTTON_CLASS}>
              Disconnect
            </button>
          )}
          <button
            type="button"
            disabled={status === 'ended'}
            onClick={() => onTerminate(session)}
            className="rounded border border-line px-2 py-0.5 text-xs text-red-300 hover:border-red-400 disabled:opacity-40"
          >
            Terminate
          </button>
        </div>
      </header>
      {message && (
        <p
          role="alert"
          className="border-b border-line bg-yellow-950/40 px-4 py-1 text-xs text-yellow-200"
        >
          {message}
        </p>
      )}
      <div
        className={`min-h-0 flex-1 overflow-hidden ${status === 'connected' ? '' : 'opacity-50'}`}
      >
        <div ref={containerRef} data-testid="terminal" className="h-full w-full" />
      </div>
    </section>
  );
}
