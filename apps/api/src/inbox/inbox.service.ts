import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  INBOX_LIMITS,
  type InboxEvent,
  type InboxItem,
  type InboxItemDetail,
  type InboxItemType,
  type InboxListQuery,
  type InboxMessage,
  type InboxPriority,
  type InboxPullRequest,
  type InboxResolution,
  type InboxSource,
  type InboxSourceState,
} from '@ecc/shared';
import { ApiError } from '../common/api-error';
import { InboxDatabase } from './inbox-database';
import { InboxRepository, StoredItem } from './inbox.repository';

export interface SourceEvent {
  kind: string;
  source: InboxEvent['source'];
  summary: string;
  occurredAt: string;
  /** Recording the same key twice is impossible: the second change is dropped as a repeat. */
  idempotencyKey?: string;
}

/**
 * What a source says about an item. Absent fields keep their stored value. Source rules decide
 * the contents; InboxService enforces what holds for every source.
 */
export interface SourceUpdate {
  /** Required to create the item when it does not exist. Without it, a missing item stays missing. */
  create?: { type: InboxItemType; source: InboxSource };
  title?: string;
  description?: string | null;
  /** Becomes the effective priority too, unless a person overrode it. */
  suggestedPriority?: InboxPriority;
  sourceState?: InboxSourceState;
  sourceSession?: string | null;
  sourceAgent?: string | null;
  /** Merged into the stored pull request fields. Required in full when creating a PR item. */
  pullRequest?: Partial<InboxPullRequest>;
  /** A genuinely new actionable condition: an acknowledged or resolved item returns to open. */
  reopen?: boolean;
  /** Resolves the item automatically, unless it is already resolved. */
  resolve?: Exclude<InboxResolution, 'manual'>;
  events: SourceEvent[];
}

export interface ApplyResult {
  item: StoredItem;
  created: boolean;
  changed: boolean;
}

type Listener = (message: InboxMessage) => void;

const SUMMARY_MAX = 500;

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Fields whose change is a real change. revision and updatedAt follow from them. */
function material(item: StoredItem): string {
  return JSON.stringify({ ...item, revision: 0, updatedAt: '' });
}

export function toPublic(item: StoredItem): InboxItem {
  const copy: Partial<StoredItem> = { ...item };
  delete copy.sourceKey;
  return copy as InboxItem;
}

/**
 * The Inbox rules that hold for every source: idempotent creation by source key, a revision on
 * every change, manual priorities that sources never overwrite, explicit status transitions, and
 * a bounded audit trail. One logical change is one transaction; listeners hear of it after commit.
 */
@Injectable()
export class InboxService {
  private readonly logger = new Logger(InboxService.name);
  private readonly listeners = new Set<Listener>();
  private depth = 0;
  private outbox: InboxMessage[] = [];

  constructor(
    private readonly database: InboxDatabase,
    private readonly repository: InboxRepository,
  ) {}

  get available(): boolean {
    return this.database.available;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Publishes a message that is not an item change, such as a completed sync. */
  publish(message: InboxMessage): void {
    if (this.depth > 0) this.outbox.push(message);
    else this.deliver([message]);
  }

  /**
   * Runs `work` as one transaction. Messages are delivered only once the outermost transaction
   * commits, and dropped if it rolls back. `work` must be synchronous, which better-sqlite3 is.
   */
  run<T>(work: () => T): T {
    this.depth += 1;
    let result: T;
    try {
      result = this.repository.transaction(work);
    } catch (error) {
      this.depth -= 1;
      if (this.depth === 0) this.outbox = [];
      throw error;
    }
    this.depth -= 1;
    if (this.depth === 0) {
      const messages = this.outbox;
      this.outbox = [];
      this.deliver(messages);
    }
    return result;
  }

  list(query: InboxListQuery, now = Date.now()): InboxItem[] {
    return this.repository.list(query, now).map(toPublic);
  }

  counts() {
    return this.repository.counts();
  }

  detail(id: string): InboxItemDetail {
    const item = this.require(id);
    return { item: toPublic(item), events: this.repository.events(id, INBOX_LIMITS.eventsInDetail) };
  }

  findByKey(sourceKey: string): StoredItem | null {
    return this.repository.findByKey(sourceKey);
  }

  pendingClaudeItems(filter: { session?: string; agent?: string } = {}): StoredItem[] {
    return this.repository.pendingClaudeItems(filter);
  }

  findKeyFamily(base: string): StoredItem[] {
    return this.repository.findKeyFamily(base);
  }

  hasEvent(idempotencyKey: string): boolean {
    return this.repository.hasEvent(idempotencyKey);
  }

  acknowledge(id: string): InboxItem {
    return this.human(id, (item, now) => {
      if (item.status === 'acknowledged') return null;
      if (item.status !== 'open') this.invalid('acknowledge', item);
      item.status = 'acknowledged';
      item.acknowledgedAt = now;
      return { kind: 'item.acknowledged', summary: 'Acknowledged.' };
    });
  }

  resolve(id: string): InboxItem {
    return this.human(id, (item, now) => {
      if (item.status === 'resolved') return null;
      item.status = 'resolved';
      item.resolution = 'manual';
      item.resolvedAt = now;
      return { kind: 'item.resolved', summary: 'Resolved manually.' };
    });
  }

  reopen(id: string): InboxItem {
    return this.human(id, (item) => {
      if (item.status === 'open') return null;
      if (item.status !== 'resolved') this.invalid('reopen', item);
      this.markOpen(item);
      return { kind: 'item.reopened', summary: 'Reopened manually.' };
    });
  }

  /** A priority is a human decision that sources never overwrite. `null` returns to the suggestion. */
  setPriority(id: string, priority: InboxPriority | null): InboxItem {
    return this.human(id, (item) => {
      if (priority === null) {
        if (!item.priorityOverridden) return null;
        item.priorityOverridden = false;
        item.priority = item.suggestedPriority;
        return {
          kind: 'priority.reset',
          summary: `Manual priority cleared. Now ${item.priority}, as suggested.`,
        };
      }
      if (item.priorityOverridden && item.priority === priority) return null;
      item.priorityOverridden = true;
      item.priority = priority;
      return {
        kind: 'priority.changed',
        summary: `Priority set to ${priority} (suggested ${item.suggestedPriority}).`,
      };
    });
  }

  /**
   * Creates or updates the item with this source key. `decide` sees the stored item, or null, and
   * returns what the source says, or null for nothing. Everything happens in one transaction.
   */
  applySource(
    sourceKey: string,
    decide: (current: StoredItem | null) => SourceUpdate | null,
  ): ApplyResult | null {
    return this.run(() => {
      const current = this.repository.findByKey(sourceKey);
      const update = decide(current);
      if (!update) return null;
      const events = update.events.filter(
        (event) => !event.idempotencyKey || !this.repository.hasEvent(event.idempotencyKey),
      );
      if (update.events.length > 0 && events.length === 0) {
        // Every event was already recorded: this is a redelivery, not news.
        return current ? { item: current, created: false, changed: false } : null;
      }
      const now = new Date().toISOString();
      if (!current) {
        if (!update.create) return null;
        return this.create(sourceKey, update, events, now);
      }
      return this.update(current, update, events, now);
    });
  }

  private create(
    sourceKey: string,
    update: SourceUpdate,
    events: SourceEvent[],
    now: string,
  ): ApplyResult {
    const create = update.create as NonNullable<SourceUpdate['create']>;
    const suggested = update.suggestedPriority ?? 'P2';
    const item: StoredItem = {
      id: randomUUID(),
      sourceKey,
      type: create.type,
      title: clip(update.title?.trim() || 'Untitled', INBOX_LIMITS.titleMax),
      description: this.description(update.description),
      priority: suggested,
      suggestedPriority: suggested,
      priorityOverridden: false,
      status: 'open',
      source: create.source,
      sourceState: update.sourceState ?? 'pending',
      sourceSession: update.sourceSession ?? null,
      sourceAgent: update.sourceAgent ?? null,
      pullRequest: update.pullRequest ? (update.pullRequest as InboxPullRequest) : null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: this.latest('', events) ?? now,
      acknowledgedAt: null,
      resolvedAt: null,
      resolution: null,
    };
    const extra: SourceEvent[] = [];
    if (update.resolve) {
      item.status = 'resolved';
      item.resolution = update.resolve;
      item.resolvedAt = now;
      extra.push(this.systemEvent('item.resolved', `Resolved automatically (${update.resolve}).`, now));
    }
    this.repository.insert(item);
    this.record(item.id, [...events, ...extra], now);
    this.outbox.push({ type: 'inbox.item.created', data: toPublic(item) });
    return { item, created: true, changed: true };
  }

  private update(
    current: StoredItem,
    update: SourceUpdate,
    events: SourceEvent[],
    now: string,
  ): ApplyResult {
    const next: StoredItem = {
      ...current,
      pullRequest: current.pullRequest ? { ...current.pullRequest } : null,
    };
    if (update.title !== undefined && update.title.trim()) {
      next.title = clip(update.title.trim(), INBOX_LIMITS.titleMax);
    }
    if (update.description !== undefined) next.description = this.description(update.description);
    if (update.sourceState) next.sourceState = update.sourceState;
    if (update.sourceSession !== undefined) next.sourceSession = update.sourceSession;
    if (update.sourceAgent !== undefined) next.sourceAgent = update.sourceAgent;
    if (update.pullRequest) {
      next.pullRequest = { ...(next.pullRequest ?? {}), ...update.pullRequest } as InboxPullRequest;
    }
    if (update.suggestedPriority) {
      next.suggestedPriority = update.suggestedPriority;
      if (!next.priorityOverridden) next.priority = update.suggestedPriority;
    }
    const activity = this.latest(current.lastActivityAt, events);
    if (activity) next.lastActivityAt = activity;

    const extra: SourceEvent[] = [];
    if (update.resolve && next.status !== 'resolved') {
      next.status = 'resolved';
      next.resolution = update.resolve;
      next.resolvedAt = now;
      extra.push(this.systemEvent('item.resolved', `Resolved automatically (${update.resolve}).`, now));
    } else if (update.reopen && next.status !== 'open') {
      this.markOpen(next);
      extra.push(this.systemEvent('item.reopened', 'Reopened by a new actionable condition.', now));
    }

    const changed = material(next) !== material(current);
    if (!changed && events.length === 0) return { item: current, created: false, changed: false };
    if (changed) {
      next.revision = current.revision + 1;
      next.updatedAt = now;
      this.repository.update(next);
    }
    this.record(next.id, [...events, ...extra], now);
    if (changed) {
      const resolvedNow = next.status === 'resolved' && current.status !== 'resolved';
      this.outbox.push({
        type: resolvedNow ? 'inbox.item.resolved' : 'inbox.item.updated',
        data: toPublic(next),
      });
    }
    return { item: next, created: false, changed };
  }

  private human(
    id: string,
    change: (item: StoredItem, now: string) => { kind: string; summary: string } | null,
  ): InboxItem {
    return this.run(() => {
      const current = this.require(id);
      const next: StoredItem = { ...current };
      const now = new Date().toISOString();
      const event = change(next, now);
      if (!event) return toPublic(current);
      next.revision = current.revision + 1;
      next.updatedAt = now;
      this.repository.update(next);
      this.record(id, [{ ...event, source: 'human', occurredAt: now }], now);
      const resolvedNow = next.status === 'resolved' && current.status !== 'resolved';
      this.outbox.push({
        type: resolvedNow ? 'inbox.item.resolved' : 'inbox.item.updated',
        data: toPublic(next),
      });
      return toPublic(next);
    });
  }

  private markOpen(item: StoredItem): void {
    item.status = 'open';
    item.resolution = null;
    item.resolvedAt = null;
    item.acknowledgedAt = null;
  }

  private record(itemId: string, events: SourceEvent[], now: string): void {
    if (events.length === 0) return;
    for (const event of events) {
      this.repository.insertEvent(
        randomUUID(),
        {
          itemId,
          kind: event.kind,
          source: event.source,
          summary: clip(event.summary, SUMMARY_MAX),
          occurredAt: event.occurredAt,
          idempotencyKey: event.idempotencyKey,
        },
        now,
      );
    }
    this.repository.pruneEvents(itemId, INBOX_LIMITS.eventsPerItem);
  }

  private systemEvent(kind: string, summary: string, now: string): SourceEvent {
    return { kind, source: 'system', summary, occurredAt: now };
  }

  /**
   * The latest of `base` and the source events' times, or null when none is later. System and
   * human events are not source activity, so they never move an item in the sort order.
   */
  private latest(base: string, events: SourceEvent[]): string | null {
    let latest: string | null = null;
    for (const { occurredAt, source } of events) {
      if (source === 'system' || source === 'human') continue;
      if (occurredAt > base && (latest === null || occurredAt > latest)) latest = occurredAt;
    }
    return latest;
  }

  private description(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? clip(trimmed, INBOX_LIMITS.descriptionMax) : null;
  }

  private require(id: string): StoredItem {
    const item = this.repository.findById(id);
    if (!item) throw new ApiError(404, 'INBOX_ITEM_NOT_FOUND', `Inbox item "${id}" does not exist.`);
    return item;
  }

  private invalid(action: string, item: StoredItem): never {
    throw new ApiError(
      409,
      'INBOX_INVALID_TRANSITION',
      `Cannot ${action} an item that is ${item.status}.`,
    );
  }

  private deliver(messages: InboxMessage[]): void {
    for (const message of messages) {
      for (const listener of this.listeners) {
        try {
          listener(message);
        } catch (error) {
          this.logger.warn(`An Inbox listener failed: ${(error as Error).message}`);
        }
      }
    }
  }
}
