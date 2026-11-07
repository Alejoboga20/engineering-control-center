import { Module } from '@nestjs/common';
import { ClaudeMonitoringModule } from '../claude-monitoring/claude-monitoring.module';
import { AgentReportsController } from './agent-reports.controller';
import { AgentReportsService } from './agent-reports.service';
import { ClaudeInboxBridge } from './claude-inbox.bridge';
import { GitHubSyncService } from './github-sync.service';
import { GitHubClient } from './github.client';
import { InboxDatabase } from './inbox-database';
import { InboxController } from './inbox.controller';
import { InboxGateway } from './inbox.gateway';
import { InboxRepository } from './inbox.repository';
import { InboxService } from './inbox.service';

/** The Engineering Inbox. Documented in docs/engineering-inbox.md. */
@Module({
  imports: [ClaudeMonitoringModule],
  controllers: [InboxController, AgentReportsController],
  providers: [
    InboxDatabase,
    InboxRepository,
    InboxService,
    AgentReportsService,
    ClaudeInboxBridge,
    GitHubClient,
    GitHubSyncService,
    InboxGateway,
  ],
})
export class InboxModule {}
