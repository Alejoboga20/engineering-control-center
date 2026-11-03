import { Module } from '@nestjs/common';
import { SessionsModule } from '../sessions/sessions.module';
import { ClaudeConfigurationDiscoveryService } from './claude-configuration-discovery.service';
import { ClaudeConfigurationController } from './claude-configuration.controller';
import { ClaudeConfigurationService } from './claude-configuration.service';

@Module({
  imports: [SessionsModule],
  controllers: [ClaudeConfigurationController],
  providers: [ClaudeConfigurationService, ClaudeConfigurationDiscoveryService],
})
export class ClaudeConfigurationModule {}
