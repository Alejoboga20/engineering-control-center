export interface SessionDto {
  name: string;
  /** Creation time as an ISO 8601 string. */
  createdAt: string;
  /** Number of attached tmux clients. This says nothing about whether a process is busy. */
  attachedClients: number;
  windows: number;
  /**
   * False when the session was created outside the dashboard with a name the dashboard does
   * not accept (for example one containing spaces). It is listed but cannot be managed here.
   */
  manageable: boolean;
}

export interface CreateSessionRequest {
  name: string;
  workingDirectory: string;
}

export interface ProjectDirectoryDto {
  name: string;
  path: string;
}

export interface ProjectsResponse {
  roots: string[];
  directories: ProjectDirectoryDto[];
}

export interface SystemStatsDto {
  /** CPU utilization, 0-100, measured since the previous sample. */
  cpuPercent: number;
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
  };
  disk: {
    path: string;
    totalBytes: number;
    availableBytes: number;
  };
  uptimeSeconds: number;
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_SESSION_NAME'
  | 'INVALID_WORKING_DIRECTORY'
  | 'WORKING_DIRECTORY_NOT_ALLOWED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  | 'TMUX_UNAVAILABLE'
  | 'TMUX_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR';

/** Body of every non-2xx API response. */
export interface ApiErrorResponse {
  statusCode: number;
  code: ApiErrorCode;
  message: string;
}
