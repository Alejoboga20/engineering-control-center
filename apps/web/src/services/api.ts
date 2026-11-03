import type {
  ApiErrorResponse,
  ClaudeConfigScope,
  ClaudeConfigScopesResponse,
  ClaudeHooksResponse,
  ClaudeResourceDetail,
  ClaudeResourceListResponse,
  ClaudeSettingsResponse,
  CreateSessionRequest,
  ProjectsResponse,
  SessionDto,
  SystemStatsDto,
} from '@ecc/shared';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch {
    throw new ApiRequestError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
  }
  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as Partial<ApiErrorResponse> | null;
    throw new ApiRequestError(
      response.status,
      error?.code ?? 'UNKNOWN_ERROR',
      error?.message ?? `Request failed with status ${response.status}.`,
    );
  }
  return body as T;
}

export type ClaudeResourceListName = 'agents' | 'skills' | 'knowledge';

export interface ClaudeConfigSelection {
  scope: ClaudeConfigScope;
  project: string | null;
}

function configQuery({ scope, project }: ClaudeConfigSelection): string {
  const params = new URLSearchParams({ scope });
  if (scope === 'project' && project) params.set('project', project);
  return `?${params.toString()}`;
}

export const api = {
  listSessions: () => request<SessionDto[]>('/sessions'),
  createSession: (body: CreateSessionRequest) =>
    request<SessionDto>('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  terminateSession: (name: string) =>
    request<void>(`/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  listProjects: () => request<ProjectsResponse>('/projects'),
  getSystemStats: () => request<SystemStatsDto>('/system/stats'),
  getClaudeConfigScopes: () => request<ClaudeConfigScopesResponse>('/claude/config/scopes'),
  listClaudeResources: (name: ClaudeResourceListName, selection: ClaudeConfigSelection) =>
    request<ClaudeResourceListResponse>(`/claude/config/${name}${configQuery(selection)}`),
  getClaudeResource: (id: string) =>
    request<ClaudeResourceDetail>(`/claude/config/resources/${encodeURIComponent(id)}`),
  getClaudeHooks: (selection: ClaudeConfigSelection) =>
    request<ClaudeHooksResponse>(`/claude/config/hooks${configQuery(selection)}`),
  getClaudeSettings: (selection: ClaudeConfigSelection) =>
    request<ClaudeSettingsResponse>(`/claude/config/settings${configQuery(selection)}`),
};
