import type {
  ApiErrorResponse,
  ClaudeConfigScope,
  ClaudeConfigScopesResponse,
  ClaudeHooksResponse,
  ClaudeResourceDetail,
  ClaudeResourceListResponse,
  ClaudeSettingsResponse,
  CreateSessionRequest,
  GitHubSyncStatus,
  InboxItem,
  InboxItemDetail,
  InboxListQuery,
  InboxListResponse,
  InboxSummary,
  ProjectsResponse,
  SessionDto,
  SystemStatsDto,
  UpdateInboxItemRequest,
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

function inboxQuery(query: InboxListQuery): string {
  const params = new URLSearchParams();
  if (query.filter) params.set('filter', query.filter);
  if (query.priority) params.set('priority', query.priority);
  if (query.status) params.set('status', query.status);
  const search = params.toString();
  return search ? `?${search}` : '';
}

export type InboxTransition = 'acknowledge' | 'resolve' | 'reopen';

const inboxItemPath = (id: string) => `/inbox/${encodeURIComponent(id)}`;

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
  listInbox: (query: InboxListQuery) => request<InboxListResponse>(`/inbox${inboxQuery(query)}`),
  getInboxSummary: () => request<InboxSummary>('/inbox/summary'),
  getInboxItem: (id: string) => request<InboxItemDetail>(inboxItemPath(id)),
  updateInboxItem: (id: string, body: UpdateInboxItemRequest) =>
    request<InboxItem>(inboxItemPath(id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  transitionInboxItem: (id: string, transition: InboxTransition) =>
    request<InboxItem>(`${inboxItemPath(id)}/${transition}`, { method: 'POST' }),
  syncGitHub: () => request<GitHubSyncStatus>('/inbox/sync/github', { method: 'POST' }),
};
