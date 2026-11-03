import { IsIn, IsOptional, Matches } from 'class-validator';
import type { ClaudeConfigScope } from '@ecc/shared';

/** Only an opaque ID selects a project, so a path can never reach the filesystem layer. */
export class ClaudeConfigQueryDto {
  @IsOptional()
  @IsIn(['global', 'project'])
  scope?: ClaudeConfigScope;

  @IsOptional()
  @Matches(/^[a-f0-9]{16}$/, { message: 'project must be a project ID.' })
  project?: string;
}
