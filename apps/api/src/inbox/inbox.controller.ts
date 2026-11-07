import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type {
  GitHubSyncStatus,
  InboxItem,
  InboxItemDetail,
  InboxListResponse,
  InboxSummary,
} from '@ecc/shared';
import { ClaudeHookCredentialsService } from '../claude-monitoring/claude-hook-credentials.service';
import { GitHubSyncService } from './github-sync.service';
import { InboxDatabase } from './inbox-database';
import { InboxListQueryDto, UpdateInboxItemDto } from './inbox.dto';
import { InboxService } from './inbox.service';

const ItemId = new ParseUUIDPipe({ version: '4' });

/** Human triage. Browsers reach it under the global Host and Origin guard. No raw SQL, no create. */
@Controller('inbox')
export class InboxController {
  constructor(
    private readonly database: InboxDatabase,
    private readonly inbox: InboxService,
    private readonly github: GitHubSyncService,
    private readonly credentials: ClaudeHookCredentialsService,
  ) {}

  @Get()
  list(@Query() query: InboxListQueryDto): InboxListResponse {
    return { items: this.inbox.list(query) };
  }

  @Get('summary')
  summary(): InboxSummary {
    return {
      ...this.inbox.counts(),
      github: this.github.status(),
      agentReportingAvailable: this.credentials.available,
    };
  }

  @Post('sync/github')
  @HttpCode(202)
  syncGitHub(): GitHubSyncStatus {
    this.database.ensureAvailable();
    return this.github.trigger();
  }

  @Get(':id')
  detail(@Param('id', ItemId) id: string): InboxItemDetail {
    return this.inbox.detail(id);
  }

  @Patch(':id')
  update(@Param('id', ItemId) id: string, @Body() body: UpdateInboxItemDto): InboxItem {
    return this.inbox.setPriority(id, body.priority);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  acknowledge(@Param('id', ItemId) id: string): InboxItem {
    return this.inbox.acknowledge(id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  resolve(@Param('id', ItemId) id: string): InboxItem {
    return this.inbox.resolve(id);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  reopen(@Param('id', ItemId) id: string): InboxItem {
    return this.inbox.reopen(id);
  }
}
