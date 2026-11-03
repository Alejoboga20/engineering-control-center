import { Body, Controller, Get, HttpCode, Post, UseGuards, Param } from '@nestjs/common';
import type {
  ClaudeHookEventResponse,
  ClaudeSessionStatus,
  ClaudeStatusResponse,
} from '@ecc/shared';
import { ApiError } from '../common/api-error';
import { SessionNamePipe } from '../sessions/session-name.pipe';
import { TmuxService } from '../tmux/tmux.service';
import { ClaudeHookAuthGuard } from './claude-hook-auth.guard';
import { ClaudeHookCredentialsService } from './claude-hook-credentials.service';
import { ClaudeHookEventDto } from './claude-hook-event.dto';
import { CLAUDE_LIMITS, ClaudeStateService } from './claude-state.service';

@Controller('claude')
export class ClaudeHooksController {
  constructor(
    private readonly state: ClaudeStateService,
    private readonly credentials: ClaudeHookCredentialsService,
    private readonly tmux: TmuxService,
  ) {}

  @Post('hooks')
  @HttpCode(202)
  @UseGuards(ClaudeHookAuthGuard)
  ingest(@Body() event: ClaudeHookEventDto): ClaudeHookEventResponse {
    const ts = Date.parse(event.timestamp);
    if (Number.isNaN(ts) || ts > Date.now() + CLAUDE_LIMITS.maxClockSkewMs) {
      // A timestamp from the future would outrank every later event, so it cannot be accepted.
      throw new ApiError(400, 'VALIDATION_ERROR', 'timestamp is not credible.');
    }
    return { accepted: this.state.record(event, ts) };
  }

  @Get('status')
  async status(): Promise<ClaudeStatusResponse> {
    return {
      ingestionAvailable: this.credentials.available,
      sessions: await this.state.snapshot(),
    };
  }

  @Get('status/:tmuxSession')
  async sessionStatus(
    @Param('tmuxSession', SessionNamePipe) tmuxSession: string,
  ): Promise<ClaudeSessionStatus> {
    const sessions = await this.state.snapshot();
    const found = sessions.find((session) => session.tmuxSession === tmuxSession);
    if (!found) {
      throw new ApiError(404, 'SESSION_NOT_FOUND', `Session "${tmuxSession}" does not exist.`);
    }
    return found;
  }
}
