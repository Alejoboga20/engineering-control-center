import type { SessionDto } from '@ecc/shared';
import { formatAge } from '../services/format';

interface SessionItemProps {
  session: SessionDto;
  selected: boolean;
  onSelect: (name: string) => void;
}

export function SessionItem({ session, selected, onSelect }: SessionItemProps) {
  const windows = `${session.windows} ${session.windows === 1 ? 'window' : 'windows'}`;
  return (
    <li>
      <button
        type="button"
        disabled={!session.manageable}
        title={
          session.manageable
            ? undefined
            : 'This name is not accepted by the dashboard. Rename it with tmux rename-session.'
        }
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(session.name)}
        className={`w-full rounded px-2 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-50 ${
          selected ? 'bg-overlay' : 'enabled:hover:bg-overlay/60'
        }`}
      >
        <span className="block truncate font-mono text-[13px]">{session.name}</span>
        <span className="block truncate text-[11px] text-muted">
          {windows} · {session.attachedClients} attached · {formatAge(session.createdAt)}
        </span>
      </button>
    </li>
  );
}
