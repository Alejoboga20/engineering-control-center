import type { SystemStatsDto } from '@ecc/shared';
import { api } from '../services/api';
import { usePolling, type PollingState } from './usePolling';

const POLL_INTERVAL_MS = 5000;

export type SystemStatsState = PollingState<SystemStatsDto>;

export function useSystemStats(): SystemStatsState {
  return usePolling(api.getSystemStats, POLL_INTERVAL_MS);
}
