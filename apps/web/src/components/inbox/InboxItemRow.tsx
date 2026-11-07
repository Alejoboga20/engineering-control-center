import type { InboxItem, InboxPriority } from '@ecc/shared';
import { formatAge } from '../../services/format';
import { PRIORITY_CLASSES, SOURCE_LABELS, STATUS_LABELS, TYPE_LABELS } from '../../services/inbox';

export function PriorityChip({ priority }: { priority: InboxPriority }) {
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${PRIORITY_CLASSES[priority]}`}
    >
      {priority}
    </span>
  );
}

/** Short facts worth seeing without opening the item. */
export function contextLabels(item: InboxItem): string[] {
  const labels: string[] = [];
  const pullRequest = item.pullRequest;
  if (pullRequest?.draft) labels.push('Draft');
  if (pullRequest?.checksState === 'failing') labels.push('Checks failing');
  if (pullRequest?.reviewState === 'changes_requested') labels.push('Changes requested');
  if (pullRequest?.reviewState === 'approved') labels.push('Approved');
  if (item.sourceState === 'merged') labels.push('Merged');
  if (item.sourceState === 'closed') labels.push('Closed');
  if (item.sourceState === 'uncertain') labels.push('Source uncertain');
  if (item.priorityOverridden) labels.push('Priority set manually');
  return labels;
}

/** Where the item comes from: the repository for a pull request, the tmux session otherwise. */
export function itemLocation(item: InboxItem): string {
  if (item.pullRequest) return `${item.pullRequest.repository}#${item.pullRequest.number}`;
  return item.sourceSession ?? 'Unknown session';
}

interface InboxItemRowProps {
  item: InboxItem;
  selected: boolean;
  onSelect: () => void;
}

export function InboxItemRow({ item, selected, onSelect }: InboxItemRowProps) {
  const isResolved = item.status === 'resolved';
  const context = contextLabels(item);
  const sessionLabel = item.pullRequest && item.sourceSession ? ` · ${item.sourceSession}` : '';

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={`w-full rounded px-2 py-2 text-left ${selected ? 'bg-overlay' : 'hover:bg-raised'} ${
          isResolved ? 'opacity-70' : ''
        }`}
      >
        <span className="flex items-start gap-2">
          <PriorityChip priority={item.priority} />
          <span className="min-w-0 flex-1 text-[13px] break-words">{item.title}</span>
        </span>
        <span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted">
          <span>{TYPE_LABELS[item.type]}</span>
          <span>{SOURCE_LABELS[item.source]}</span>
          <span className="min-w-0 wrap-anywhere">
            {itemLocation(item)}
            {sessionLabel}
          </span>
          <span>{STATUS_LABELS[item.status]}</span>
          <span>{formatAge(item.lastActivityAt)}</span>
        </span>
        {context.length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {context.map((label) => (
              <span key={label} className="rounded bg-overlay px-1.5 py-0.5 text-[10px] text-amber-300">
                {label}
              </span>
            ))}
          </span>
        )}
      </button>
    </li>
  );
}
