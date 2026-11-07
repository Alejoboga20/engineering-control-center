import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { ClaudeHookEventRequest, ClaudeSessionStatus, ClaudeState } from '@ecc/shared';
import { TmuxService, TmuxSession } from '../tmux/tmux.service';
import { applyEvent, ClaudeInstance, isIrrelevantEvent, NormalizedEvent } from './claude-instance';

export const CLAUDE_LIMITS = {
  maxSessions: 256,
  maxInstancesPerSession: 16,
  maxRememberedEventIds: 4096,
  /** The reporter runs on this machine, so a timestamp further ahead than this is not credible. */
  maxClockSkewMs: 5 * 60_000,
} as const;

/**
 * How long each state may be believed without a new event. A silent Working is the one that goes
 * bad quickly, because Claude Code sends no hook when the person interrupts it with Esc.
 */
export const CLAUDE_STALE_AFTER_MS: Partial<Record<ClaudeState, number>> = {
  working: 10 * 60_000,
  needs_attention: 24 * 60 * 60_000,
  idle: 24 * 60 * 60_000,
};

const SWEEP_INTERVAL_MS = 15_000;
/** Activity-only updates are coalesced. State changes are always published immediately. */
const ACTIVITY_PUBLISH_INTERVAL_MS = 5_000;

type Listener = (status: ClaudeSessionStatus) => void;

/** An event that changed monitoring state, after validation, deduplication and ordering. */
export interface AcceptedClaudeEvent {
  request: ClaudeHookEventRequest;
  ts: number;
  /** The instance's state before and after this event. */
  previousState: ClaudeState;
  state: ClaudeState;
  /** Other Claude instances in the same pane that this event showed to be gone. */
  superseded: string[];
}

type EventListener = (event: AcceptedClaudeEvent) => void;

/**
 * Latest observed Claude activity per tmux session, in memory only. Losing it on restart is
 * acceptable: every session falls back to Unknown until its next event.
 */
@Injectable()
export class ClaudeStateService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ClaudeStateService.name);
  /** Insertion order is recency of events, which makes eviction least-recently-active. */
  private readonly sessions = new Map<string, Map<string, ClaudeInstance>>();
  private readonly seenEventIds = new Set<string>();
  private readonly published = new Map<string, { key: string; material: string; at: number }>();
  private readonly listeners = new Set<Listener>();
  private readonly eventListeners = new Set<EventListener>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly tmux: TmuxService) {}

  onApplicationBootstrap(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  onApplicationShutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Hears every accepted event, after the status has been published. A failing listener is
   * logged and cannot affect monitoring.
   */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Returns false when the event was ignored as a duplicate, as outdated, or as irrelevant. */
  record(request: ClaudeHookEventRequest, ts: number): boolean {
    if (this.seenEventIds.has(request.eventId)) return false;
    this.rememberEventId(request.eventId);

    const event: NormalizedEvent = { ...request, ts };
    if (isIrrelevantEvent(event)) return false;

    const instances = this.sessions.get(request.tmuxSession) ?? new Map<string, ClaudeInstance>();
    let instance = instances.get(request.claudeSessionId);
    if (instance && (ts < instance.lastEventTs || this.endedAtSameInstant(instance, ts))) {
      return false;
    }
    instance ??= {
      id: request.claudeSessionId,
      state: 'unknown',
      lastEvent: request.eventType,
      lastEventTs: ts,
      lastActivityTs: ts,
    };
    const previousState = instance.state;
    applyEvent(instance, event);

    let superseded: string[] = [];
    if (event.eventType === 'SessionStart' && event.source !== 'compact') {
      superseded = this.supersedeOthersInPane(instances, instance);
    }
    instances.delete(instance.id);
    instances.set(instance.id, instance);
    this.evictInstances(instances);

    this.sessions.delete(request.tmuxSession);
    this.sessions.set(request.tmuxSession, instances);
    this.evictSessions();

    this.publish(request.tmuxSession);
    this.notifyEvent({ request, ts, previousState, state: instance.state, superseded });
    return true;
  }

  /** The combined status of a tmux session, computed at read time so staleness is always current. */
  statusOf(tmuxSession: string, now = Date.now()): ClaudeSessionStatus {
    const instances = [...(this.sessions.get(tmuxSession)?.values() ?? [])];
    if (instances.length === 0) {
      return { tmuxSession, state: 'unknown', monitored: false, reason: 'no-events', instanceCount: 0 };
    }

    const notEnded = instances.filter((instance) => instance.state !== 'offline');
    const fresh = notEnded.filter((instance) => !this.isStale(instance, now));
    const latest = (list: ClaudeInstance[]) =>
      list.reduce((a, b) => (b.lastEventTs >= a.lastEventTs ? b : a));

    if (fresh.length > 1) {
      // Each instance's state is known, but one label cannot describe them. The exception is an
      // explicit request for attention, which is reliable however many instances exist.
      const waiting = fresh.filter((instance) => instance.state === 'needs_attention');
      const shown = latest(waiting.length > 0 ? waiting : fresh);
      return this.describe(
        tmuxSession,
        shown,
        waiting.length > 0 ? 'needs_attention' : 'unknown',
        'multiple-instances',
        fresh.length,
      );
    }
    if (fresh.length === 1) {
      const [only] = fresh;
      return this.describe(
        tmuxSession,
        only,
        only.state,
        only.state === 'unknown' ? 'insufficient-events' : null,
        1,
      );
    }
    if (notEnded.length > 0) {
      return this.describe(tmuxSession, latest(notEnded), 'unknown', 'stale', notEnded.length);
    }
    return this.describe(tmuxSession, latest(instances), 'offline', null, 0);
  }

  /** Every tmux session, each with its status. tmux decides which sessions exist. */
  async snapshot(): Promise<ClaudeSessionStatus[]> {
    const sessions = await this.tmux.listSessions();
    this.reconcile(sessions);
    const now = Date.now();
    return sessions.map((session) => this.statusOf(session.name, now));
  }

  /** Forgets a session whose name is being released or reused. Its next owner starts clean. */
  forget(tmuxSession: string): void {
    if (this.sessions.delete(tmuxSession)) this.publish(tmuxSession);
  }

  /** Publishes transitions that no event triggers, such as staleness and vanished sessions. */
  async sweep(): Promise<void> {
    if (this.sessions.size === 0) return;
    try {
      this.reconcile(await this.tmux.listSessions());
    } catch (error) {
      this.logger.warn(`Could not list tmux sessions: ${(error as Error).message}`);
    }
    for (const name of [...this.sessions.keys()]) this.publish(name, true);
  }

  /** Drops state for sessions that are gone, and for events older than a reused session name. */
  private reconcile(sessions: TmuxSession[]): void {
    const created = new Map(sessions.map((session) => [session.name, session.createdAt.getTime()]));
    for (const [name, instances] of this.sessions) {
      const createdAt = created.get(name);
      for (const instance of instances.values()) {
        if (createdAt === undefined || instance.lastEventTs < createdAt) {
          instances.delete(instance.id);
        }
      }
      if (instances.size === 0) this.forget(name);
    }
  }

  private isStale(instance: ClaudeInstance, now: number): boolean {
    const limit = CLAUDE_STALE_AFTER_MS[instance.state];
    return limit !== undefined && now - instance.lastActivityTs > limit;
  }

  private endedAtSameInstant(instance: ClaudeInstance, ts: number): boolean {
    return instance.state === 'offline' && ts === instance.lastEventTs;
  }

  /**
   * A pane runs one foreground program, so a new Claude in a pane normally means the previous one
   * is gone, even if it crashed without SessionEnd. If it was only suspended behind a nested
   * Claude, its next event brings it back, and the status then reports multiple instances.
   */
  private supersedeOthersInPane(
    instances: Map<string, ClaudeInstance>,
    current: ClaudeInstance,
  ): string[] {
    if (!current.pane) return [];
    const superseded: string[] = [];
    for (const other of instances.values()) {
      if (other !== current && other.pane === current.pane && other.lastEventTs <= current.lastEventTs) {
        if (other.state !== 'offline') superseded.push(other.id);
        other.state = 'offline';
      }
    }
    return superseded;
  }

  private notifyEvent(event: AcceptedClaudeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(`A Claude event listener failed: ${(error as Error).message}`);
      }
    }
  }

  private describe(
    tmuxSession: string,
    instance: ClaudeInstance,
    state: ClaudeState,
    reason: ClaudeSessionStatus['reason'],
    instanceCount: number,
  ): ClaudeSessionStatus {
    return {
      tmuxSession,
      state,
      monitored: true,
      reason,
      instanceCount,
      claudeSessionId: instance.id,
      lastEvent: instance.lastEvent,
      lastEventAt: new Date(instance.lastEventTs).toISOString(),
      lastActivityAt: new Date(instance.lastActivityTs).toISOString(),
    };
  }

  private publish(tmuxSession: string, force = false): void {
    const now = Date.now();
    const status = this.statusOf(tmuxSession, now);
    const key = JSON.stringify(status);
    const material = `${status.state}|${status.reason}|${status.instanceCount}|${status.claudeSessionId}`;
    const previous = this.published.get(tmuxSession);
    if (previous?.key === key) return;
    if (
      !force &&
      previous?.material === material &&
      now - previous.at < ACTIVITY_PUBLISH_INTERVAL_MS
    ) {
      return;
    }
    if (status.monitored) {
      this.published.delete(tmuxSession);
      this.published.set(tmuxSession, { key, material, at: now });
      if (this.published.size > CLAUDE_LIMITS.maxSessions) {
        this.published.delete(this.published.keys().next().value as string);
      }
    } else {
      this.published.delete(tmuxSession);
    }
    for (const listener of this.listeners) listener(status);
  }

  private rememberEventId(id: string): void {
    this.seenEventIds.add(id);
    if (this.seenEventIds.size > CLAUDE_LIMITS.maxRememberedEventIds) {
      this.seenEventIds.delete(this.seenEventIds.values().next().value as string);
    }
  }

  private evictInstances(instances: Map<string, ClaudeInstance>): void {
    while (instances.size > CLAUDE_LIMITS.maxInstancesPerSession) {
      const victim =
        [...instances.values()].find((instance) => instance.state === 'offline') ??
        instances.values().next().value;
      instances.delete((victim as ClaudeInstance).id);
    }
  }

  private evictSessions(): void {
    while (this.sessions.size > CLAUDE_LIMITS.maxSessions) {
      this.forget(this.sessions.keys().next().value as string);
    }
  }
}
