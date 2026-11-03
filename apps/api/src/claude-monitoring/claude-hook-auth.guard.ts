import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { ClaudeHookCredentialsService } from './claude-hook-credentials.service';

/** Hook ingestion only. Browsers never hold this token, and use the existing Host/Origin guard. */
@Injectable()
export class ClaudeHookAuthGuard implements CanActivate {
  constructor(private readonly credentials: ClaudeHookCredentialsService) {}

  canActivate(context: ExecutionContext): boolean {
    const { authorization } = context.switchToHttp().getRequest<Request>().headers;
    if (this.credentials.isAuthorized(authorization)) return true;
    throw new ApiError(401, 'UNAUTHORIZED', 'A valid hook token is required.');
  }
}
