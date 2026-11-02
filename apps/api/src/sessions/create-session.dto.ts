import { CreateSessionRequest, SESSION_NAME_PATTERN, SESSION_NAME_RULES } from '@ecc/shared';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateSessionDto implements CreateSessionRequest {
  @IsString()
  @Matches(SESSION_NAME_PATTERN, { message: `Invalid session name. ${SESSION_NAME_RULES}` })
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  workingDirectory!: string;
}
