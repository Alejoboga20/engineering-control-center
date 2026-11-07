import { Injectable } from '@nestjs/common';
import type {
  InboxEvent,
  InboxItem,
  InboxListQuery,
  InboxPriority,
  InboxPullRequest,
  InboxStatus,
} from '@ecc/shared';
import { InboxDatabase } from './inbox-database';

/** An item as stored: the public shape plus its stable source identity. */
export interface StoredItem extends InboxItem {
  sourceKey: string;
}

export interface NewEvent extends Omit<InboxEvent, 'id' | 'recordedAt'> {
  idempotencyKey?: string;
}

export interface SyncStateRow {
  repository: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  initialSyncDone: boolean;
  baselineAt: string | null;
}

export interface PendingReport {
  repository: string;
  number: number;
  sourceSession: string | null;
  sourceAgent: string | null;
  reportedAt: string;
}

interface ItemRow {
  id: string;
  type: InboxItem['type'];
  source_key: string;
  title: string;
  description: string | null;
  priority: InboxPriority;
  suggested_priority: InboxPriority;
  priority_overridden: number;
  status: InboxStatus;
  source: InboxItem['source'];
  source_state: InboxItem['sourceState'];
  source_session: string | null;
  source_agent: string | null;
  pr_repository: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_author: string | null;
  pr_draft: number | null;
  pr_review_state: string | null;
  pr_checks_state: string | null;
  pr_attribution: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  resolution: InboxItem['resolution'];
}

const ITEM_COLUMNS = [
  'id',
  'type',
  'source_key',
  'title',
  'description',
  'priority',
  'suggested_priority',
  'priority_overridden',
  'status',
  'source',
  'source_state',
  'source_session',
  'source_agent',
  'pr_repository',
  'pr_number',
  'pr_url',
  'pr_author',
  'pr_draft',
  'pr_review_state',
  'pr_checks_state',
  'pr_attribution',
  'revision',
  'created_at',
  'updated_at',
  'last_activity_at',
  'acknowledged_at',
  'resolved_at',
  'resolution',
] as const;

/** Resolved items stay in the default view this long, so recent decisions remain visible. */
export const RECENTLY_RESOLVED_MS = 7 * 24 * 60 * 60_000;
/** A bound on one listing. The Inbox is a queue for one person, not an archive. */
export const LIST_LIMIT = 500;
const ACTIONABILITY = `CASE status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END`;
const AGENT_BLOCKER_TYPES = `('human_input', 'permission_request', 'agent_failure')`;

function toItem(row: ItemRow): StoredItem {
  const pullRequest =
    row.pr_repository !== null && row.pr_number !== null
      ? {
          repository: row.pr_repository,
          number: row.pr_number,
          url: row.pr_url ?? '',
          author: row.pr_author,
          draft: row.pr_draft === 1,
          reviewState: (row.pr_review_state ?? 'unknown') as InboxPullRequest['reviewState'],
          checksState: (row.pr_checks_state ?? 'unknown') as InboxPullRequest['checksState'],
          attribution: (row.pr_attribution ?? 'discovered') as InboxPullRequest['attribution'],
        }
      : null;
  return {
    id: row.id,
    sourceKey: row.source_key,
    type: row.type,
    title: row.title,
    description: row.description,
    priority: row.priority,
    suggestedPriority: row.suggested_priority,
    priorityOverridden: row.priority_overridden === 1,
    status: row.status,
    source: row.source,
    sourceState: row.source_state,
    sourceSession: row.source_session,
    sourceAgent: row.source_agent,
    pullRequest,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
  };
}

function toRow(item: StoredItem): ItemRow {
  const pr = item.pullRequest;
  return {
    id: item.id,
    type: item.type,
    source_key: item.sourceKey,
    title: item.title,
    description: item.description,
    priority: item.priority,
    suggested_priority: item.suggestedPriority,
    priority_overridden: item.priorityOverridden ? 1 : 0,
    status: item.status,
    source: item.source,
    source_state: item.sourceState,
    source_session: item.sourceSession,
    source_agent: item.sourceAgent,
    pr_repository: pr?.repository ?? null,
    pr_number: pr?.number ?? null,
    pr_url: pr?.url ?? null,
    pr_author: pr?.author ?? null,
    pr_draft: pr ? (pr.draft ? 1 : 0) : null,
    pr_review_state: pr?.reviewState ?? null,
    pr_checks_state: pr?.checksState ?? null,
    pr_attribution: pr?.attribution ?? null,
    revision: item.revision,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    last_activity_at: item.lastActivityAt,
    acknowledged_at: item.acknowledgedAt,
    resolved_at: item.resolvedAt,
    resolution: item.resolution,
  };
}

/**
 * All SQL for the Inbox. Every statement is parameterized; no caller-supplied text is ever
 * interpolated into SQL. Transactions belong to InboxService, which knows what one change is.
 */
@Injectable()
export class InboxRepository {
  constructor(private readonly database: InboxDatabase) {}

  private get db() {
    return this.database.db;
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  findById(id: string): StoredItem | null {
    const row = this.db.prepare('SELECT * FROM inbox_items WHERE id = ?').get(id) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  findByKey(sourceKey: string): StoredItem | null {
    const row = this.db.prepare('SELECT * FROM inbox_items WHERE source_key = ?').get(sourceKey) as
      | ItemRow
      | undefined;
    return row ? toItem(row) : null;
  }

  findByPullRequest(repository: string, number: number): StoredItem | null {
    const row = this.db
      .prepare('SELECT * FROM inbox_items WHERE pr_repository = ? AND pr_number = ?')
      .get(repository, number) as ItemRow | undefined;
    return row ? toItem(row) : null;
  }

  /** Items whose key is `base` or `base:<n>`, newest first. */
  findKeyFamily(base: string): StoredItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox_items WHERE source_key = ? OR substr(source_key, 1, ?) = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(base, base.length + 1, `${base}:`) as ItemRow[];
    return rows.map(toItem);
  }

  insert(item: StoredItem): void {
    const columns = ITEM_COLUMNS.join(', ');
    const values = ITEM_COLUMNS.map((column) => `@${column}`).join(', ');
    this.db.prepare(`INSERT INTO inbox_items (${columns}) VALUES (${values})`).run(toRow(item));
  }

  update(item: StoredItem): void {
    const assignments = ITEM_COLUMNS.filter((column) => column !== 'id' && column !== 'source_key')
      .map((column) => `${column} = @${column}`)
      .join(', ');
    this.db.prepare(`UPDATE inbox_items SET ${assignments} WHERE id = @id`).run(toRow(item));
  }

  list(query: InboxListQuery, now: number): StoredItem[] {
    const where: string[] = [];
    const params: Record<string, string | number> = {};
    switch (query.filter ?? 'all') {
      case 'needs_attention':
        where.push(`status = 'open'`, `priority = 'P1'`);
        break;
      case 'pull_requests':
        where.push(`type = 'pull_request'`, `status <> 'resolved'`);
        break;
      case 'agent_blockers':
        where.push(`type IN ${AGENT_BLOCKER_TYPES}`, `status <> 'resolved'`);
        break;
      case 'resolved':
        where.push(`status = 'resolved'`);
        break;
      case 'all':
        where.push(`(status <> 'resolved' OR resolved_at >= @recent)`);
        params.recent = new Date(now - RECENTLY_RESOLVED_MS).toISOString();
        break;
    }
    if (query.priority) {
      where.push('priority = @priority');
      params.priority = query.priority;
    }
    if (query.status) {
      where.push('status = @status');
      params.status = query.status;
    }
    const sql =
      `SELECT * FROM inbox_items WHERE ${where.join(' AND ')} ` +
      `ORDER BY priority ASC, ${ACTIONABILITY}, last_activity_at DESC, id ` +
      `LIMIT ${LIST_LIMIT}`;
    return (this.db.prepare(sql).all(params) as ItemRow[]).map(toItem);
  }

  counts(): { open: number; needsAttention: number; pullRequestsAwaitingReview: number; acknowledged: number } {
    return this.db
      .prepare(
        `SELECT
           count(*) FILTER (WHERE status = 'open') AS open,
           count(*) FILTER (WHERE status = 'open' AND priority = 'P1') AS needsAttention,
           count(*) FILTER (WHERE type = 'pull_request' AND status <> 'resolved'
             AND source_state = 'open' AND pr_draft = 0) AS pullRequestsAwaitingReview,
           count(*) FILTER (WHERE status = 'acknowledged') AS acknowledged
         FROM inbox_items`,
      )
      .get() as ReturnType<InboxRepository['counts']>;
  }

  /**
   * Hook-raised Claude items still believed pending, optionally for one tmux session or Claude
   * session. Agent reports are excluded: they stay valid until a person resolves them.
   */
  pendingClaudeItems(filter: { session?: string; agent?: string } = {}): StoredItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox_items WHERE source = 'claude' AND source_state = 'pending'
         AND substr(source_key, 1, 7) = 'claude:'
         AND (@session IS NULL OR source_session = @session)
         AND (@agent IS NULL OR source_agent = @agent)`,
      )
      .all({ session: filter.session ?? null, agent: filter.agent ?? null }) as ItemRow[];
    return rows.map(toItem);
  }

  /** Pull request items that the database still believes open. */
  openPullRequests(repository: string): StoredItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM inbox_items WHERE type = 'pull_request' AND pr_repository = ?
         AND source_state = 'open' ORDER BY pr_number`,
      )
      .all(repository) as ItemRow[];
    return rows.map(toItem);
  }

  hasEvent(idempotencyKey: string): boolean {
    return (
      this.db.prepare('SELECT 1 FROM inbox_events WHERE idempotency_key = ?').get(idempotencyKey) !==
      undefined
    );
  }

  insertEvent(id: string, event: NewEvent, recordedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO inbox_events (id, item_id, kind, source, summary, idempotency_key, occurred_at, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.itemId,
        event.kind,
        event.source,
        event.summary,
        event.idempotencyKey ?? null,
        event.occurredAt,
        recordedAt,
      );
  }

  /** Keeps the newest `keep` events of an item. */
  pruneEvents(itemId: string, keep: number): void {
    this.db
      .prepare(
        `DELETE FROM inbox_events WHERE item_id = @itemId AND rowid NOT IN
           (SELECT rowid FROM inbox_events WHERE item_id = @itemId ORDER BY rowid DESC LIMIT @keep)`,
      )
      .run({ itemId, keep });
  }

  events(itemId: string, limit: number): InboxEvent[] {
    return this.db
      .prepare(
        `SELECT id, item_id AS itemId, kind, source, summary, occurred_at AS occurredAt,
                recorded_at AS recordedAt
         FROM inbox_events WHERE item_id = ? ORDER BY rowid DESC LIMIT ?`,
      )
      .all(itemId, limit) as InboxEvent[];
  }

  syncStates(): SyncStateRow[] {
    return (
      this.db.prepare('SELECT * FROM github_sync_state ORDER BY repository').all() as {
        repository: string;
        last_sync_at: string | null;
        last_success_at: string | null;
        last_error: string | null;
        initial_sync_done: number;
        baseline_at: string | null;
      }[]
    ).map((row) => ({
      repository: row.repository,
      lastSyncAt: row.last_sync_at,
      lastSuccessAt: row.last_success_at,
      lastError: row.last_error,
      initialSyncDone: row.initial_sync_done === 1,
      baselineAt: row.baseline_at,
    }));
  }

  saveSyncState(state: SyncStateRow): void {
    this.db
      .prepare(
        `INSERT INTO github_sync_state
           (repository, last_sync_at, last_success_at, last_error, initial_sync_done, baseline_at)
         VALUES (@repository, @lastSyncAt, @lastSuccessAt, @lastError, @initialSyncDone, @baselineAt)
         ON CONFLICT (repository) DO UPDATE SET
           last_sync_at = excluded.last_sync_at, last_success_at = excluded.last_success_at,
           last_error = excluded.last_error, initial_sync_done = excluded.initial_sync_done,
           baseline_at = excluded.baseline_at`,
      )
      .run({ ...state, initialSyncDone: state.initialSyncDone ? 1 : 0 });
  }

  savePendingReport(report: PendingReport): void {
    this.db
      .prepare(
        `INSERT INTO github_pending_reports (repository, number, source_session, source_agent, reported_at)
         VALUES (@repository, @number, @sourceSession, @sourceAgent, @reportedAt)
         ON CONFLICT (repository, number) DO UPDATE SET
           source_session = excluded.source_session, source_agent = excluded.source_agent,
           reported_at = excluded.reported_at`,
      )
      .run(report);
  }

  pendingReports(repository: string): PendingReport[] {
    return this.db
      .prepare(
        `SELECT repository, number, source_session AS sourceSession, source_agent AS sourceAgent,
                reported_at AS reportedAt
         FROM github_pending_reports WHERE repository = ? ORDER BY number`,
      )
      .all(repository) as PendingReport[];
  }

  deletePendingReport(repository: string, number: number): void {
    this.db
      .prepare('DELETE FROM github_pending_reports WHERE repository = ? AND number = ?')
      .run(repository, number);
  }

  deletePendingReportsBefore(cutoff: string): void {
    this.db.prepare('DELETE FROM github_pending_reports WHERE reported_at < ?').run(cutoff);
  }
}
