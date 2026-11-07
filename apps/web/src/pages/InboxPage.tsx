import { useEffect, useRef, useState } from 'react';
import {
  INBOX_PRIORITIES,
  INBOX_STATUSES,
  type InboxFilter,
  type InboxPriority,
  type InboxStatus,
} from '@ecc/shared';
import { EmptyMessage, ErrorMessage, LoadingMessage } from '../components/configuration/states';
import { InboxItemDetails } from '../components/inbox/InboxItemDetails';
import { InboxItemRow } from '../components/inbox/InboxItemRow';
import { InboxSummaryStrip } from '../components/inbox/InboxSummaryStrip';
import type { InboxControl } from '../hooks/useInbox';
import { INBOX_FILTERS, STATUS_LABELS } from '../services/inbox';

const CONTROL = 'rounded border border-line bg-surface px-2 py-1 text-xs';
const ANY = '';

const EMPTY_TEXT: Record<InboxFilter, string> = {
  all: 'Nothing needs you right now.',
  needs_attention: 'No open P1 items.',
  pull_requests: 'No pull requests waiting.',
  agent_blockers: 'No agent is blocked.',
  resolved: 'Nothing resolved in this view.',
};

/** Below Tailwind's `md` breakpoint the details sit under the whole list. */
const STACKED_QUERY = '(max-width: 767.98px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function matchesMedia(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/** Brings a section into view when the layout is stacked; side by side, both are visible already. */
function revealWhenStacked(element: HTMLElement | null) {
  const canScroll = element !== null && typeof element.scrollIntoView === 'function';
  if (!canScroll || !matchesMedia(STACKED_QUERY)) return;
  element.scrollIntoView({ behavior: matchesMedia(REDUCED_MOTION_QUERY) ? 'auto' : 'smooth', block: 'start' });
}

interface InboxPageProps {
  inbox: InboxControl;
  /** Names of the tmux sessions that exist now. */
  runningSessions: ReadonlySet<string>;
  onOpenTerminal: (session: string) => void;
}

export function InboxPage({ inbox, runningSessions, onOpenTerminal }: InboxPageProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealRequest, setRevealRequest] = useState(0);
  const listRef = useRef<HTMLElement>(null);
  const detailsRef = useRef<HTMLElement>(null);

  // Runs after the details for the new selection have rendered.
  useEffect(() => {
    if (revealRequest > 0) revealWhenStacked(detailsRef.current);
  }, [revealRequest]);

  const selectItem = (id: string) => {
    setSelectedId(id);
    setRevealRequest((count) => count + 1);
  };
  const { query, items } = inbox;
  const filter = query.filter ?? 'all';
  // Selecting by lookup means an item that leaves the current filter simply stops being selected.
  const selected = items?.find((item) => item.id === selectedId) ?? null;
  const isFirstLoad = items === null && !inbox.error;
  const isEmpty = items !== null && items.length === 0;
  const hasNarrowing = Boolean(query.priority || query.status);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:overflow-hidden">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h2 className="text-sm font-semibold">Engineering Inbox</h2>
        {!inbox.connected && (
          <span className="text-xs text-amber-300">Live updates disconnected. Reconnecting…</span>
        )}
      </header>
      <InboxSummaryStrip
        summary={inbox.summary}
        summaryError={inbox.summaryError}
        syncing={inbox.syncing}
        syncError={inbox.syncError}
        onSync={() => void inbox.syncNow()}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <div role="tablist" aria-label="Inbox filters" className="flex flex-wrap gap-1">
          {INBOX_FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="tab"
              aria-selected={filter === option.id}
              onClick={() => inbox.setQuery({ ...query, filter: option.id })}
              className={`rounded px-2 py-1 text-xs whitespace-nowrap ${
                filter === option.id ? 'bg-overlay text-ink' : 'text-muted hover:text-ink'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Priority
          <select
            className={CONTROL}
            value={query.priority ?? ANY}
            onChange={(event) =>
              inbox.setQuery({ ...query, priority: (event.target.value || undefined) as InboxPriority | undefined })
            }
          >
            <option value={ANY}>Any</option>
            {INBOX_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Status
          <select
            className={CONTROL}
            value={query.status ?? ANY}
            onChange={(event) =>
              inbox.setQuery({ ...query, status: (event.target.value || undefined) as InboxStatus | undefined })
            }
          >
            <option value={ANY}>Any</option>
            {INBOX_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {inbox.actionError && (
        <div role="alert" className="mx-4 mt-2 flex items-start gap-2 rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">
          <span className="min-w-0 flex-1 break-words">{inbox.actionError}</span>
          <button type="button" onClick={inbox.dismissActionError} className="shrink-0 hover:text-ink">
            Dismiss
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <section
          ref={listRef}
          aria-label="Item list"
          className="shrink-0 border-b border-line p-2 md:w-96 md:overflow-y-auto md:border-r md:border-b-0"
        >
          {isFirstLoad && <LoadingMessage>Loading the inbox…</LoadingMessage>}
          {inbox.error && <ErrorMessage>{inbox.error}</ErrorMessage>}
          {isEmpty && (
            <EmptyMessage>
              {hasNarrowing ? 'Nothing matches these filters.' : EMPTY_TEXT[filter]}
            </EmptyMessage>
          )}
          {items && items.length > 0 && (
            <ul aria-label="Inbox items" aria-busy={inbox.loading}>
              {items.map((item) => (
                <InboxItemRow
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  onSelect={() => selectItem(item.id)}
                />
              ))}
            </ul>
          )}
        </section>
        <section
          ref={detailsRef}
          aria-label="Item details"
          className="min-h-0 min-w-0 flex-1 scroll-mt-2 md:overflow-y-auto"
        >
          {selected && (
            <button
              type="button"
              onClick={() =>
                revealWhenStacked(listRef.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? listRef.current)
              }
              className="mx-4 mt-3 text-xs text-accent hover:underline md:hidden"
            >
              Back to list
            </button>
          )}
          {selected ? (
            <InboxItemDetails
              key={selected.id}
              item={selected}
              sessionRunning={selected.sourceSession !== null && runningSessions.has(selected.sourceSession)}
              onTransition={(item, transition) => void inbox.transition(item, transition)}
              onSetPriority={(item, priority) => void inbox.setPriority(item, priority)}
              onOpenTerminal={onOpenTerminal}
            />
          ) : (
            <EmptyMessage>Select an item to see its details.</EmptyMessage>
          )}
        </section>
      </div>
    </div>
  );
}
