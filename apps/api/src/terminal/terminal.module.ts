import { Module } from '@nestjs/common';
import { TmuxModule } from '../tmux/tmux.module';
import { nodePtyFactory, PTY_FACTORY } from './pty.factory';
import { TerminalGateway } from './terminal.gateway';

@Module({
  imports: [TmuxModule],
  providers: [TerminalGateway, { provide: PTY_FACTORY, useValue: nodePtyFactory }],
})
export class TerminalModule {}
