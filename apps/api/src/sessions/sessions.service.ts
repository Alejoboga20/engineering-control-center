import { Injectable } from '@nestjs/common';
import { isValidSessionName, SessionDto } from '@ecc/shared';
import { ClaudeStateService } from '../claude-monitoring/claude-state.service';
import { ApiError } from '../common/api-error';
import { TmuxService, TmuxSession } from '../tmux/tmux.service';
import {
  TmuxCommandError,
  TmuxDuplicateSessionError,
  TmuxSessionNotFoundError,
  TmuxUnavailableError,
} from '../tmux/tmux.errors';
import { ProjectDirectoriesService } from './project-directories.service';

function toDto(session: TmuxSession): SessionDto {
  return {
    name: session.name,
    createdAt: session.createdAt.toISOString(),
    attachedClients: session.attachedClients,
    windows: session.windows,
    manageable: isValidSessionName(session.name),
  };
}

function toApiError(error: unknown): unknown {
  if (error instanceof TmuxSessionNotFoundError) {
    return new ApiError(404, 'SESSION_NOT_FOUND', error.message);
  }
  if (error instanceof TmuxDuplicateSessionError) {
    return new ApiError(409, 'SESSION_ALREADY_EXISTS', error.message);
  }
  if (error instanceof TmuxUnavailableError) {
    return new ApiError(503, 'TMUX_UNAVAILABLE', error.message);
  }
  if (error instanceof TmuxCommandError) {
    return new ApiError(500, 'TMUX_ERROR', error.message);
  }
  return error;
}

/** Holds no state. tmux is asked every time, so a backend restart loses nothing. */
@Injectable()
export class SessionsService {
  constructor(
    private readonly tmux: TmuxService,
    private readonly directories: ProjectDirectoriesService,
    private readonly claudeState: ClaudeStateService,
  ) {}

  async list(): Promise<SessionDto[]> {
    try {
      const sessions = await this.tmux.listSessions();
      return sessions.map(toDto).sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      throw toApiError(error);
    }
  }

  async create(name: string, workingDirectory: string): Promise<SessionDto> {
    const directory = await this.directories.resolveWorkingDirectory(workingDirectory);
    try {
      await this.tmux.createSession(name, directory);
      this.claudeState.forget(name);
      const sessions = await this.tmux.listSessions();
      const created = sessions.find((session) => session.name === name);
      return created
        ? toDto(created)
        : toDto({
            name,
            createdAt: new Date(),
            attachedClients: 0,
            windows: 1,
          });
    } catch (error) {
      throw toApiError(error);
    }
  }

  async terminate(name: string): Promise<void> {
    try {
      await this.tmux.killSession(name);
      this.claudeState.forget(name);
    } catch (error) {
      throw toApiError(error);
    }
  }
}
