import { HttpException } from '@nestjs/common';
import type { ApiErrorCode, ApiErrorResponse } from '@ecc/shared';

/** An HTTP error with a stable machine-readable code. */
export class ApiError extends HttpException {
  constructor(statusCode: number, code: ApiErrorCode, message: string) {
    super({ statusCode, code, message } satisfies ApiErrorResponse, statusCode);
  }
}
