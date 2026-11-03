import {
  CLAUDE_HOOK_EVENTS,
  ClaudeHookEventRequest,
  type ClaudeHookEventType,
  SESSION_NAME_PATTERN,
} from '@ecc/shared';
import { IsIn, IsISO8601, IsOptional, IsString, Matches } from 'class-validator';

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * The global validation pipe rejects any field not declared here. That is deliberate: a request
 * carrying a prompt, tool arguments or a transcript fails instead of having them ignored silently.
 */
export class ClaudeHookEventDto implements ClaudeHookEventRequest {
  @Matches(IDENTIFIER)
  eventId!: string;

  @Matches(IDENTIFIER)
  claudeSessionId!: string;

  @Matches(SESSION_NAME_PATTERN)
  tmuxSession!: string;

  @IsIn(CLAUDE_HOOK_EVENTS)
  eventType!: ClaudeHookEventType;

  @IsString()
  @IsISO8601({ strict: true })
  timestamp!: string;

  @IsOptional()
  @Matches(/^%\d{1,10}$/)
  pane?: string;

  @IsOptional()
  @Matches(IDENTIFIER)
  source?: string;

  @IsOptional()
  @Matches(IDENTIFIER)
  notificationType?: string;

  @IsOptional()
  @Matches(TOOL_NAME)
  toolName?: string;

  @IsOptional()
  @Matches(IDENTIFIER)
  agentId?: string;
}
