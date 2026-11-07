import { Module } from '@nestjs/common';
import { TmuxModule } from '../tmux/tmux.module';
import { ClaudeHookAuthGuard } from './claude-hook-auth.guard';
import { ClaudeHookCredentialsService } from './claude-hook-credentials.service';
import { ClaudeHooksController } from './claude-hooks.controller';
import { ClaudeMonitoringGateway } from './claude-monitoring.gateway';
import { ClaudeStateService } from './claude-state.service';

@Module({
  imports: [TmuxModule],
  controllers: [ClaudeHooksController],
  providers: [
    ClaudeStateService,
    ClaudeHookCredentialsService,
    ClaudeHookAuthGuard,
    ClaudeMonitoringGateway,
  ],
  exports: [ClaudeStateService, ClaudeHookCredentialsService, ClaudeHookAuthGuard],
})
export class ClaudeMonitoringModule {}
