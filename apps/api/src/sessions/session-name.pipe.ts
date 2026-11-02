import { Injectable, PipeTransform } from '@nestjs/common';
import { isValidSessionName, SESSION_NAME_RULES } from '@ecc/shared';
import { ApiError } from '../common/api-error';

@Injectable()
export class SessionNamePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!isValidSessionName(value)) {
      throw new ApiError(400, 'INVALID_SESSION_NAME', `Invalid session name. ${SESSION_NAME_RULES}`);
    }
    return value;
  }
}
