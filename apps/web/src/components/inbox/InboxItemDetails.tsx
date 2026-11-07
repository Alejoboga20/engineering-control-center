import { useCallback, type ReactNode } from 'react';
import {
  INBOX_PRIORITIES,
  type InboxItem,
  type InboxPriority,
  type InboxResolution,
  type InboxSourceState,
  type PullRequestChecksState,
  type PullRequestReviewState,
} from '@ecc/shared';
import { useLoad } from '../../hooks/useLoad';
import { api, type InboxTransition } from '../../services/api';
import { formatAge } from '../../services/format';
import { isGitHubUrl, SOURCE_LABELS, STATUS_LABELS, TYPE_LABELS } from '../../services/inbox';
import { EmptyMessage, ErrorMessage, LoadingMessage } from '../configuration/states';
import { PriorityChip } from './InboxItemRow';

const SOURCE_STATE_LABELS: Record<InboxSourceState, string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
  pending: 'Pending',
  cleared: 'Cleared',
  uncertain: 'Uncertain',
};

const REVIEW_LABELS: Record<PullRequestReviewState, string> = {
  review_required: 'Review required',
  approved: 'Approved',
  changes_requested: 'Changes requested',
  none: 'None',
  unknown: 'Unknown',
};

const CHECKS_LABELS: Record<PullRequestChecksState, string> = {
  passing: 'Passing',
  failing: 'Failing',
  pending: 'Pending',
  none: 'None',
  unknown: 'Unknown',
};

const RESOLUTION_LABELS: Record<InboxResolution, string> = {
  manual: 'Resolved by you',
  auto_merged: 'Pull request merged',
  auto_closed: 'Pull request closed',
  auto_cleared: 'Claude Code moved on',
};

export const PENDING_PERMISSION_CAVEAT =
  'Claude Code may have moved on already: denying a permission request sends no event, so this stays pending until the next prompt in that session.';

export const UNCERTAIN_EXPLANATION =
  'Nothing reliable says whether this is still waiting, for example after a server restart or once its tmux session ended. Check the terminal, then resolve it yourself.';

const BUTTON = 'rounded border border-line px-2 py-1 text-xs whitespace-nowrap hover:border-accent hover:text-accent';

function explanationOf(item: InboxItem): string | null {
  const isPendingPermission = item.type === 'permission_request' && item.sourceState === 'pending';
  if (isPendingPermission) return PENDING_PERMISSION_CAVEAT;
  if (item.sourceState === 'uncertain') return UNCERTAIN_EXPLANATION;
  return null;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="text-xs wrap-anywhere">{children}</dd>
    </div>
  );
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface InboxItemDetailsProps {
  item: InboxItem;
  /** Whether the item's tmux session exists right now. */
  sessionRunning: boolean;
  onTransition: (item: InboxItem, transition: InboxTransition) => void;
  onSetPriority: (item: InboxItem, priority: InboxPriority | null) => void;
  onOpenTerminal: (session: string) => void;
}

export function InboxItemDetails(props: InboxItemDetailsProps) {
  const { item } = props;
  const load = useCallback(() => api.getInboxItem(item.id), [item.id]);
  // Reloaded on every change, so that the history includes what changed it.
  const detail = useLoad(load, item.revision);
  const pullRequest = item.pullRequest;
  const explanation = explanationOf(item);
  const gitHubUrl = isGitHubUrl(pullRequest?.url) ? pullRequest?.url : null;
  const session = item.sourceSession;
  const canOpenTerminal = session !== null && props.sessionRunning;
  const isSessionGone = session !== null && !props.sessionRunning;
  // A pull request found on GitHub has no session; a Claude item without one is worth flagging.
  const hasSessionField = session !== null || item.source === 'claude';
  const canAcknowledge = item.status === 'open';
  const canResolve = item.status !== 'resolved';
  const canReopen = item.status === 'resolved';
  const events = detail.data?.events ?? [];

  return (
    <article className="flex flex-col gap-4 p-4">
      <header className="flex flex-col gap-2">
        <div className="flex items-start gap-2">
          <PriorityChip priority={item.priority} />
          <h3 className="min-w-0 flex-1 text-sm font-semibold break-words">{item.title}</h3>
        </div>
        <p className="text-xs text-muted">
          {TYPE_LABELS[item.type]} · {STATUS_LABELS[item.status]}
          {item.resolution ? ` · ${RESOLUTION_LABELS[item.resolution]}` : ''}
        </p>
      </header>

      {explanation && (
        <p className="rounded bg-amber-950/40 px-2 py-1.5 text-xs text-amber-200">{explanation}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {canAcknowledge && (
          <button type="button" className={BUTTON} onClick={() => props.onTransition(item, 'acknowledge')}>
            Acknowledge
          </button>
        )}
        {canResolve && (
          <button type="button" className={BUTTON} onClick={() => props.onTransition(item, 'resolve')}>
            Resolve
          </button>
        )}
        {canReopen && (
          <button type="button" className={BUTTON} onClick={() => props.onTransition(item, 'reopen')}>
            Reopen
          </button>
        )}
        {gitHubUrl && (
          <a className={BUTTON} href={gitHubUrl} target="_blank" rel="noopener noreferrer">
            Open on GitHub
          </a>
        )}
        {canOpenTerminal && (
          <button type="button" className={BUTTON} onClick={() => props.onOpenTerminal(session)}>
            Open terminal
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1.5 text-muted">
          Priority
          <select
            className="rounded border border-line bg-surface px-2 py-1 text-xs text-ink"
            value={item.priority}
            onChange={(event) => props.onSetPriority(item, event.target.value as InboxPriority)}
          >
            {INBOX_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <span className="text-muted">Suggested: {item.suggestedPriority}</span>
        {item.priorityOverridden && (
          <button type="button" className={BUTTON} onClick={() => props.onSetPriority(item, null)}>
            Reset to suggested
          </button>
        )}
      </div>

      {item.description && (
        <section aria-label="Description">
          {/* Untrusted text: rendered as plain text, never as HTML or Markdown. */}
          <p className="text-[13px] whitespace-pre-wrap break-words">{item.description}</p>
        </section>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        <Field label="Source">{SOURCE_LABELS[item.source]}</Field>
        <Field label="Source state">{SOURCE_STATE_LABELS[item.sourceState]}</Field>
        {hasSessionField && (
          <Field label="tmux session">
            {session ?? 'Unknown session'}
            {isSessionGone && <span className="text-muted"> (not running)</span>}
          </Field>
        )}
        {item.sourceAgent && <Field label="Claude session">{item.sourceAgent}</Field>}
        {pullRequest && (
          <>
            <Field label="Repository">{pullRequest.repository}</Field>
            <Field label="Pull request">#{pullRequest.number}</Field>
            <Field label="Author">{pullRequest.author ?? 'Unknown'}</Field>
            <Field label="Draft">{pullRequest.draft ? 'Yes' : 'No'}</Field>
            <Field label="Review">{REVIEW_LABELS[pullRequest.reviewState]}</Field>
            <Field label="Checks">{CHECKS_LABELS[pullRequest.checksState]}</Field>
            <Field label="Attribution">
              {pullRequest.attribution === 'agent_reported' ? 'Reported by an agent' : 'Discovered on GitHub'}
            </Field>
          </>
        )}
        <Field label="Created">{timeOf(item.createdAt)}</Field>
        <Field label="Last activity">{formatAge(item.lastActivityAt)}</Field>
      </dl>

      <section aria-label="History">
        <h4 className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">History</h4>
        {detail.loading && !detail.data && <LoadingMessage>Loading history…</LoadingMessage>}
        {detail.error && <ErrorMessage>{detail.error}</ErrorMessage>}
        {detail.data && events.length === 0 && <EmptyMessage>No events recorded.</EmptyMessage>}
        <ol className="flex flex-col gap-1.5">
          {events.map((event) => (
            <li key={event.id} className="text-xs">
              <span className="font-mono text-[11px] text-muted">{event.kind}</span>
              <span className="text-muted"> · {timeOf(event.occurredAt)}</span>
              <p className="whitespace-pre-wrap break-words">{event.summary}</p>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
