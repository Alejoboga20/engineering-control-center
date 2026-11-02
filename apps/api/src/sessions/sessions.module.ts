import { Module } from '@nestjs/common';
import { TmuxModule } from '../tmux/tmux.module';
import { ProjectDirectoriesService } from './project-directories.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [TmuxModule],
  controllers: [SessionsController],
  providers: [SessionsService, ProjectDirectoriesService],
})
export class SessionsModule {}
