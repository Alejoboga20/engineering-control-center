import {
  type AgentReportRequest,
  INBOX_LIMITS,
  INBOX_PRIORITIES,
  INBOX_STATUSES,
  type InboxFilter,
  type InboxListQuery,
  type InboxPriority,
  type InboxStatus,
  SESSION_NAME_PATTERN,
  type UpdateInboxItemRequest,
} from '@ecc/shared';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const FILTERS: InboxFilter[] = ['all', 'needs_attention', 'pull_requests', 'agent_blockers', 'resolved'];
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
/** No control characters at all, including C1 and the bidirectional overrides that disguise text. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const SINGLE_LINE = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/;
/** The same, except that newline and tab are allowed. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const MULTI_LINE = /^[^\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]*$/;

export class InboxListQueryDto implements InboxListQuery {
  @IsOptional()
  @IsIn(FILTERS)
  filter?: InboxFilter;

  @IsOptional()
  @IsIn(INBOX_PRIORITIES)
  priority?: InboxPriority;

  @IsOptional()
  @IsIn(INBOX_STATUSES)
  status?: InboxStatus;
}

export class UpdateInboxItemDto implements UpdateInboxItemRequest {
  /** Required. `null` is accepted and clears a manual priority. */
  @ValidateIf((body: UpdateInboxItemDto) => body.priority !== null)
  @IsIn(INBOX_PRIORITIES)
  priority!: InboxPriority | null;
}

/**
 * What an agent may report. The global pipe rejects unknown fields, so a report cannot smuggle a
 * path, a command or a transcript in under another name. Which fields each type requires is
 * checked by the controller.
 */
export class AgentReportDto implements AgentReportRequest {
  @IsIn(['human_input', 'pull_request'])
  type!: 'human_input' | 'pull_request';

  @IsOptional()
  @Matches(INBOX_LIMITS.idempotencyKeyPattern)
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(INBOX_LIMITS.titleMax)
  @Matches(SINGLE_LINE, { message: 'title must not contain control characters' })
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(INBOX_LIMITS.descriptionMax)
  @Matches(MULTI_LINE, { message: 'description must not contain control characters other than newline and tab' })
  description?: string;

  @IsOptional()
  @IsIn(INBOX_PRIORITIES)
  priority?: InboxPriority;

  @IsOptional()
  @Matches(SESSION_NAME_PATTERN)
  sourceSession?: string;

  @IsOptional()
  @Matches(IDENTIFIER)
  sourceAgent?: string;

  @IsOptional()
  @Matches(INBOX_LIMITS.repositoryPattern)
  repository?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  pullRequestNumber?: number;
}
