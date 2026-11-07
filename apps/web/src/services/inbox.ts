import {
  INBOX_PRIORITIES,
  INBOX_STATUSES,
  INBOX_STREAM_PATH,
  type InboxFilter,
  type InboxItem,
  type InboxItemType,
  type InboxListQuery,
  type InboxMessage,
  type InboxPriority,
  type InboxSource,
  type InboxStatus,
} from '@ecc/shared';

/** The `all` filter keeps resolved items this long, as the server does. */
export const RESOLVED_VISIBLE_MS = 7 * 24 * 60 * 60 * 1000;

const AGENT_BLOCKER_TYPES: InboxItemType[] = ['human_input', 'permission_request', 'agent_failure'];

const MESSAGE_TYPES = new Set<InboxMessage['type']>([
  'inbox.item.created',
  'inbox.item.updated',
  'inbox.item.resolved',
  'inbox.sync.completed',
  'inbox.hello',
]);

export const INBOX_FILTERS: { id: InboxFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'needs_attention', label: 'Needs Attention' },
  { id: 'pull_requests', label: 'Pull Requests' },
  { id: 'agent_blockers', label: 'Agent Blockers' },
  { id: 'resolved', label: 'Resolved' },
];

export const TYPE_LABELS: Record<InboxItemType, string> = {
  pull_request: 'Pull request',
  human_input: 'Input needed',
  permission_request: 'Permission request',
  agent_failure: 'Agent failure',
};

export const SOURCE_LABELS: Record<InboxSource, string> = {
  github: 'GitHub',
  claude: 'Claude Code',
  manual: 'Manual',
};

export const STATUS_LABELS: Record<InboxStatus, string> = {
  open: 'Open',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
};

export const PRIORITY_CLASSES: Record<InboxPriority, string> = {
  P1: 'bg-red-950/70 text-red-300',
  P2: 'bg-amber-950/70 text-amber-300',
  P3: 'bg-overlay text-muted',
};

export function inboxStreamUrl(): string {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}${INBOX_STREAM_PATH}`;
}

export function parseInboxMessage(raw: unknown): InboxMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const message = JSON.parse(raw) as Partial<InboxMessage> | null;
    const isKnown = message !== null && MESSAGE_TYPES.has(message.type as InboxMessage['type']);
    return isKnown && typeof message.data === 'object' && message.data !== null
      ? (message as InboxMessage)
      : null;
  } catch {
    return null;
  }
}

/** The server's order: priority, then open before acknowledged before resolved, then newest activity. */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  const byPriority = INBOX_PRIORITIES.indexOf(a.priority) - INBOX_PRIORITIES.indexOf(b.priority);
  if (byPriority !== 0) return byPriority;
  const byStatus = INBOX_STATUSES.indexOf(a.status) - INBOX_STATUSES.indexOf(b.status);
  if (byStatus !== 0) return byStatus;
  return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
}

function matchesFilter(item: InboxItem, filter: InboxFilter, now: number): boolean {
  const isResolved = item.status === 'resolved';
  switch (filter) {
    case 'needs_attention':
      return item.status === 'open' && item.priority === 'P1';
    case 'pull_requests':
      return item.type === 'pull_request' && !isResolved;
    case 'agent_blockers':
      return AGENT_BLOCKER_TYPES.includes(item.type) && !isResolved;
    case 'resolved':
      return isResolved;
    case 'all': {
      const resolvedAt = item.resolvedAt ? Date.parse(item.resolvedAt) : now;
      return !isResolved || now - resolvedAt <= RESOLVED_VISIBLE_MS;
    }
  }
}

/** Mirrors the server's query, so that live updates enter and leave the list it returned. */
export function matchesInboxQuery(item: InboxItem, query: InboxListQuery, now = Date.now()): boolean {
  const isPriorityMatch = !query.priority || item.priority === query.priority;
  const isStatusMatch = !query.status || item.status === query.status;
  return isPriorityMatch && isStatusMatch && matchesFilter(item, query.filter ?? 'all', now);
}

/** Only GitHub's own HTTPS pages are linked, whatever URL the data carries. */
export function isGitHubUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === 'github.com' && !parsed.username;
  } catch {
    return false;
  }
}
