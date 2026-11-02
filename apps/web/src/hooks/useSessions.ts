import { useCallback } from 'react';
import type { CreateSessionRequest, SessionDto } from '@ecc/shared';
import { api } from '../services/api';
import { usePolling } from './usePolling';

const POLL_INTERVAL_MS = 5000;

export function useSessions() {
  const { data, loading, error, refresh } = usePolling(api.listSessions, POLL_INTERVAL_MS);

  const createSession = useCallback(
    async (request: CreateSessionRequest): Promise<SessionDto> => {
      const created = await api.createSession(request);
      await refresh();
      return created;
    },
    [refresh],
  );

  const terminateSession = useCallback(
    async (name: string): Promise<void> => {
      await api.terminateSession(name);
      await refresh();
    },
    [refresh],
  );

  return { sessions: data, loading, error, refresh, createSession, terminateSession };
}
