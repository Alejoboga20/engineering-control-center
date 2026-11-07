import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { AgentReportResponse } from '@ecc/shared';
import { ClaudeHookAuthGuard } from '../claude-monitoring/claude-hook-auth.guard';
import { ApiError } from '../common/api-error';
import { AgentReportsService } from './agent-reports.service';
import { GitHubSyncService } from './github-sync.service';
import { InboxDatabase } from './inbox-database';
import { AgentReportDto } from './inbox.dto';

const HUMAN_INPUT_ONLY = ['title', 'description', 'priority'] as const;
const PULL_REQUEST_ONLY = ['repository', 'pullRequestNumber'] as const;

/**
 * Structured reports from agents, through the local MCP server. Authenticated with the hook
 * token, which browsers never hold. An agent can report; it can never resolve, approve or merge.
 */
@Controller('inbox/events')
export class AgentReportsController {
  constructor(
    private readonly database: InboxDatabase,
    private readonly reports: AgentReportsService,
    private readonly github: GitHubSyncService,
  ) {}

  @Post('agent')
  @HttpCode(202)
  @UseGuards(ClaudeHookAuthGuard)
  async report(@Body() body: AgentReportDto): Promise<AgentReportResponse> {
    this.database.ensureAvailable();
    if (body.type === 'human_input') {
      this.forbid(body, PULL_REQUEST_ONLY);
      if (!body.title?.trim()) throw this.invalid('title is required for human_input.');
      return this.reports.reportHumanInput({
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? 'P2',
        sourceSession: body.sourceSession ?? null,
        sourceAgent: body.sourceAgent ?? null,
        idempotencyKey: body.idempotencyKey,
      });
    }
    this.forbid(body, HUMAN_INPUT_ONLY);
    if (!body.repository || body.pullRequestNumber === undefined) {
      throw this.invalid('repository and pullRequestNumber are required for pull_request.');
    }
    return this.github.reportPullRequest({
      repository: body.repository,
      number: body.pullRequestNumber,
      sourceSession: body.sourceSession ?? null,
      sourceAgent: body.sourceAgent ?? null,
      idempotencyKey: body.idempotencyKey,
    });
  }

  private forbid(body: AgentReportDto, fields: readonly (keyof AgentReportDto)[]): void {
    const present = fields.filter((field) => body[field] !== undefined);
    if (present.length > 0) {
      throw this.invalid(`${present.join(', ')} not allowed for ${body.type}.`);
    }
  }

  private invalid(message: string): ApiError {
    return new ApiError(400, 'VALIDATION_ERROR', message);
  }
}
