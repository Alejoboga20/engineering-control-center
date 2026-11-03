import { Module } from '@nestjs/common';
import { ClaudeMonitoringModule } from '../claude-monitoring/claude-monitoring.module';
import { TmuxModule } from '../tmux/tmux.module';
import { ProjectDirectoriesService } from './project-directories.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [TmuxModule, ClaudeMonitoringModule],
  controllers: [SessionsController],
  providers: [SessionsService, ProjectDirectoriesService],
})
export class SessionsModule {}
