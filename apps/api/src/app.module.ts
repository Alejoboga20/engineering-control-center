import { Module } from '@nestjs/common';
import { ClaudeConfigurationModule } from './claude-configuration/claude-configuration.module';
import { ClaudeMonitoringModule } from './claude-monitoring/claude-monitoring.module';
import { ConfigModule } from './config/config.module';
import { SessionsModule } from './sessions/sessions.module';
import { SystemModule } from './system/system.module';
import { TerminalModule } from './terminal/terminal.module';

@Module({
  imports: [
    ConfigModule,
    ClaudeMonitoringModule,
    ClaudeConfigurationModule,
    SessionsModule,
    TerminalModule,
    SystemModule,
  ],
})
export class AppModule {}
