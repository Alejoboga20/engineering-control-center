import { Module } from '@nestjs/common';
import { ClaudeMonitoringModule } from './claude-monitoring/claude-monitoring.module';
import { ConfigModule } from './config/config.module';
import { SessionsModule } from './sessions/sessions.module';
import { SystemModule } from './system/system.module';
import { TerminalModule } from './terminal/terminal.module';

@Module({
  imports: [ConfigModule, ClaudeMonitoringModule, SessionsModule, TerminalModule, SystemModule],
})
export class AppModule {}
