import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GitHubSyncStatus,
  InboxItem,
  InboxListQuery,
  InboxPriority,
  InboxSummary,
} from '@ecc/shared';
import { api, ApiRequestError, type InboxTransition } from '../services/api';
import {
  compareInboxItems,
  inboxStreamUrl,
  matchesInboxQuery,
  parseInboxMessage,
} from '../services/inbox';

export const INBOX_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
/** Item messages often come in bursts, for example during a GitHub sync. */
const SUMMARY_REFRESH_DELAY_MS = 250;
const DEFAULT_QUERY: InboxListQuery = { filter: 'all' };

const TRANSITION_VERBS: Record<InboxTransition, string> = {
  acknowledge: 'acknowledge',
  resolve: 'resolve',
  reopen: 'reopen',
};

export interface InboxControl {
  /** Whether the live connection is up. Items stay on screen while it is down. */
  connected: boolean;
  /** Null until the first list arrives. */
  items: InboxItem[] | null;
  loading: boolean;
  error: string | null;
  summary: InboxSummary | null;
  summaryError: string | null;
  /** The last failed action, after its optimistic change was rolled back. */
  actionError: string | null;
  query: InboxListQuery;
  setQuery: (query: InboxListQuery) => void;
  transition: (item: InboxItem, transition: InboxTransition) => Promise<void>;
  setPriority: (item: InboxItem, priority: InboxPriority | null) => Promise<void>;
  dismissActionError: () => void;
  syncing: boolean;
  syncError: string | null;
  syncNow: () => Promise<void>;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Request failed.';
}

function isInboxItem(value: unknown): value is InboxItem {
  const candidate = value as Partial<InboxItem> | null;
  return typeof candidate?.id === 'string' && typeof candidate.revision === 'number';
}

function isSyncStatus(value: unknown): value is GitHubSyncStatus {
  return typeof (value as Partial<GitHubSyncStatus> | null)?.configured === 'boolean';
}

function placeItem(items: InboxItem[], item: InboxItem, query: InboxListQuery): InboxItem[] {
  const others = items.filter((candidate) => candidate.id !== item.id);
  const next = matchesInboxQuery(item, query) ? [...others, item] : others;
  return next.sort(compareInboxItems);
}

function optimisticTransition(item: InboxItem, transition: InboxTransition): InboxItem {
  const now = new Date().toISOString();
  switch (transition) {
    case 'acknowledge':
      return { ...item, status: 'acknowledged', acknowledgedAt: now };
    case 'resolve':
      return { ...item, status: 'resolved', resolvedAt: now, resolution: 'manual' };
    case 'reopen':
      return { ...item, status: 'open', resolvedAt: null, resolution: null };
  }
}

function optimisticPriority(item: InboxItem, priority: InboxPriority | null): InboxItem {
  return priority === null
    ? { ...item, priority: item.suggestedPriority, priorityOverridden: false }
    : { ...item, priority, priorityOverridden: true };
}

/**
 * The Engineering Inbox, kept live. SQLite on the server is the source of truth: every
 * `inbox.hello`, sent first on each connection, triggers a fresh list and summary, so nothing missed
 * while disconnected can linger. Item messages are applied by revision, so late ones are dropped.
 */
export function useInbox(): InboxControl {
  const [connected, setConnected] = useState(false);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQueryState] = useState<InboxListQuery>(DEFAULT_QUERY);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const queryRef = useRef(query);
  /** The highest revision seen per item, including items the current filter hides. */
  const revisions = useRef(new Map<string, number>());
  /** Items received while a list request is in flight, which may be newer than its reply. */
  const receivedDuringLoad = useRef<Map<string, InboxItem> | null>(null);
  const listRequest = useRef(0);
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);

  const loadSummary = useCallback(async () => {
    try {
      const next = await api.getInboxSummary();
      if (!mounted.current) return;
      setSummary(next);
      setSummaryError(null);
    } catch (cause) {
      if (mounted.current) setSummaryError(messageOf(cause));
    }
  }, []);

  const scheduleSummary = useCallback(() => {
    clearTimeout(summaryTimer.current);
    summaryTimer.current = setTimeout(() => void loadSummary(), SUMMARY_REFRESH_DELAY_MS);
  }, [loadSummary]);

  const loadList = useCallback(async (requested: InboxListQuery) => {
    const request = ++listRequest.current;
    const received = new Map<string, InboxItem>();
    receivedDuringLoad.current = received;
    setLoading(true);
    try {
      const response = await api.listInbox(requested);
      if (request !== listRequest.current || !mounted.current) return;
      const merged = new Map(response.items.map((item) => [item.id, item]));
      for (const [id, item] of received) {
        const listed = merged.get(id);
        if (!listed || item.revision > listed.revision) merged.set(id, item);
      }
      const visible = [...merged.values()].filter((item) => matchesInboxQuery(item, requested));
      for (const item of merged.values()) revisions.current.set(item.id, item.revision);
      setItems(visible.sort(compareInboxItems));
      setError(null);
    } catch (cause) {
      if (request === listRequest.current && mounted.current) setError(messageOf(cause));
    } finally {
      if (request === listRequest.current) {
        receivedDuringLoad.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  const applyItem = useCallback(
    (incoming: InboxItem) => {
      const seen = revisions.current.get(incoming.id);
      const isStale = seen !== undefined && incoming.revision <= seen;
      if (isStale) return;
      revisions.current.set(incoming.id, incoming.revision);
      receivedDuringLoad.current?.set(incoming.id, incoming);
      setItems((current) => current && placeItem(current, incoming, queryRef.current));
      scheduleSummary();
    },
    [scheduleSummary],
  );

  useEffect(() => {
    mounted.current = true;
    let socket: WebSocket | null = null;
    let disposed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      const ws = new WebSocket(inboxStreamUrl());
      socket = ws;

      ws.onmessage = (event: MessageEvent<unknown>) => {
        const message = parseInboxMessage(event.data);
        if (!message) return;
        switch (message.type) {
          case 'inbox.hello':
            attempts = 0;
            setConnected(true);
            void loadList(queryRef.current);
            void loadSummary();
            break;
          case 'inbox.sync.completed':
            setSummary((current) => current && { ...current, github: message.data });
            break;
          default:
            applyItem(message.data);
        }
      };

      ws.onclose = () => {
        if (disposed) return;
        setConnected(false);
        const delay = INBOX_RETRY_DELAYS_MS[Math.min(attempts, INBOX_RETRY_DELAYS_MS.length - 1)];
        attempts++;
        timer = setTimeout(connect, delay);
      };
    }

    // Deferred so that React StrictMode's first, immediately discarded mount opens no socket.
    // The first load does not wait for the socket, so the Inbox works over REST even where the
    // socket cannot open (a proxy without upgrades, a rejected Origin).
    timer = setTimeout(() => {
      void loadList(queryRef.current);
      void loadSummary();
      connect();
    }, 0);

    return () => {
      disposed = true;
      mounted.current = false;
      clearTimeout(timer);
      clearTimeout(summaryTimer.current);
      socket?.close();
    };
  }, [applyItem, loadList, loadSummary]);

  const setQuery = useCallback(
    (next: InboxListQuery) => {
      queryRef.current = next;
      setQueryState(next);
      void loadList(next);
    },
    [loadList],
  );

  /** Shows a change before the server confirms it, and puts the item back if the server refuses. */
  const runOptimistic = useCallback(
    async (item: InboxItem, optimistic: InboxItem, call: () => Promise<unknown>, verb: string) => {
      setActionError(null);
      setItems((current) => current && placeItem(current, optimistic, queryRef.current));
      try {
        const result = await call();
        if (isInboxItem(result)) applyItem(result);
        scheduleSummary();
      } catch (cause) {
        // A newer server version replaces the optimistic one anyway, so only roll back to the
        // revision this action started from.
        const isUnchangedSinceAction = revisions.current.get(item.id) === item.revision;
        if (isUnchangedSinceAction) {
          setItems((current) => current && placeItem(current, item, queryRef.current));
        }
        if (mounted.current) setActionError(`Could not ${verb} "${item.title}": ${messageOf(cause)}`);
      }
    },
    [applyItem, scheduleSummary],
  );

  const transition = useCallback(
    (item: InboxItem, name: InboxTransition) =>
      runOptimistic(
        item,
        optimisticTransition(item, name),
        () => api.transitionInboxItem(item.id, name),
        TRANSITION_VERBS[name],
      ),
    [runOptimistic],
  );

  const setPriority = useCallback(
    (item: InboxItem, priority: InboxPriority | null) =>
      runOptimistic(
        item,
        optimisticPriority(item, priority),
        () => api.updateInboxItem(item.id, { priority }),
        'change the priority of',
      ),
    [runOptimistic],
  );

  const syncNow = useCallback(async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const status = await api.syncGitHub();
      if (isSyncStatus(status) && mounted.current) {
        setSummary((current) => current && { ...current, github: status });
      }
    } catch (cause) {
      const isAlreadyRunning = cause instanceof ApiRequestError && cause.status === 409;
      if (!mounted.current) return;
      setSyncError(isAlreadyRunning ? 'A GitHub sync is already running.' : messageOf(cause));
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }, []);

  const dismissActionError = useCallback(() => setActionError(null), []);

  return {
    connected,
    items,
    loading,
    error,
    summary,
    summaryError,
    actionError,
    query,
    setQuery,
    transition,
    setPriority,
    dismissActionError,
    syncing,
    syncError,
    syncNow,
  };
}
