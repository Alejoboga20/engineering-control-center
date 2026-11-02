import { Module } from '@nestjs/common';
import { TmuxRunner } from './tmux-runner';
import { TmuxService } from './tmux.service';

@Module({
  providers: [TmuxRunner, TmuxService],
  exports: [TmuxService],
})
export class TmuxModule {}
