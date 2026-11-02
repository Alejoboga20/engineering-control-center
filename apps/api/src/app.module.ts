import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { SessionsModule } from './sessions/sessions.module';
import { SystemModule } from './system/system.module';
import { TerminalModule } from './terminal/terminal.module';

@Module({
  imports: [ConfigModule, SessionsModule, TerminalModule, SystemModule],
})
export class AppModule {}
