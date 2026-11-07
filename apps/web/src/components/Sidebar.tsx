import type { ReactNode } from 'react';
import type { SessionDto } from '@ecc/shared';
import type { ClaudeMonitorView } from '../services/claude-status';
import type { AttentionNotificationControl } from '../hooks/useAttentionNotifications';
import { AttentionNotificationToggle } from './AttentionNotificationToggle';
import { SessionList } from './SessionList';

export type View = 'sessions' | 'server' | 'configuration' | 'inbox';

interface SidebarProps {
  sessions: SessionDto[] | null;
  loading: boolean;
  error: string | null;
  selected: string | null;
  view: View;
  /** Open P1 items in the Engineering Inbox, once known. */
  inboxAttention: number;
  monitor: ClaudeMonitorView;
  notifications: AttentionNotificationControl;
  onSelect: (name: string) => void;
  onCreate: () => void;
  onNavigate: (view: View) => void;
}

function NavButton(props: {
  active: boolean;
  label: string;
  onClick: () => void;
  badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      className={`relative flex-auto rounded px-1 py-1 text-xs whitespace-nowrap ${
        props.active ? 'bg-overlay text-ink' : 'text-muted hover:text-ink'
      }`}
    >
      {props.label}
      {props.badge}
    </button>
  );
}

export function Sidebar(props: SidebarProps) {
  const inboxBadge = props.inboxAttention > 0 && (
    <span className="absolute -top-1 -right-0.5 rounded-full bg-red-700 px-1 text-[9px] leading-[14px] font-semibold text-white">
      {props.inboxAttention}
      <span className="sr-only"> open P1</span>
    </span>
  );

  return (
    <aside className="flex max-h-56 w-full shrink-0 flex-col border-b border-line bg-raised md:max-h-none md:w-64 md:border-r md:border-b-0">
      <div className="px-4 pt-3 pb-2">
        <h1 className="text-sm font-semibold tracking-tight">Engineering Control Center</h1>
      </div>
      <nav aria-label="Server navigation" className="flex flex-wrap gap-0.5 px-2.5 pb-2">
        <NavButton
          label="Sessions"
          active={props.view === 'sessions'}
          onClick={() => props.onNavigate('sessions')}
        />
        <NavButton
          label="Server"
          active={props.view === 'server'}
          onClick={() => props.onNavigate('server')}
        />
        <NavButton
          label="Configuration"
          active={props.view === 'configuration'}
          onClick={() => props.onNavigate('configuration')}
        />
        <NavButton
          label="Inbox"
          active={props.view === 'inbox'}
          badge={inboxBadge}
          onClick={() => props.onNavigate('inbox')}
        />
      </nav>
      <div className="flex items-center justify-between px-4 py-2">
        <h2 className="text-xs font-medium tracking-wide whitespace-nowrap text-muted uppercase">
          tmux sessions
        </h2>
        <div className="flex items-center gap-1.5">
          <AttentionNotificationToggle control={props.notifications} />
          <button
            type="button"
            onClick={props.onCreate}
            className="rounded border border-line px-2 py-0.5 text-xs whitespace-nowrap hover:border-accent hover:text-accent"
          >
            New session
          </button>
        </div>
      </div>
      {props.notifications.unavailableReason && (
        <p className="px-4 pb-2 text-xs text-muted">{props.notifications.unavailableReason}</p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SessionList
          sessions={props.sessions}
          loading={props.loading}
          error={props.error}
          selected={props.view === 'sessions' ? props.selected : null}
          monitor={props.monitor}
          onSelect={props.onSelect}
        />
      </div>
    </aside>
  );
}
