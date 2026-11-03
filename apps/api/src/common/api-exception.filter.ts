import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { ApiErrorCode, ApiErrorResponse } from '@ecc/shared';
import type { Response } from 'express';

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
};

/** Gives every error response the same shape, and never leaks internals on a 500. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.status(this.statusOf(exception)).json(this.toBody(exception));
  }

  private statusOf(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    const status = (exception as { status?: unknown })?.status;
    // Errors raised by the body parser, such as an oversized or malformed payload.
    return typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
  }

  private toBody(exception: unknown): ApiErrorResponse {
    const statusCode = this.statusOf(exception);
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && 'code' in body) return body as ApiErrorResponse;
      const raw = typeof body === 'object' ? (body as { message?: unknown }).message : body;
      const message = Array.isArray(raw) ? raw.join('; ') : String(raw ?? exception.message);
      return { statusCode, code: STATUS_CODES[statusCode] ?? 'INTERNAL_ERROR', message };
    }
    if (statusCode < 500) {
      return { statusCode, code: 'VALIDATION_ERROR', message: 'Malformed request.' };
    }
    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    return { statusCode, code: 'INTERNAL_ERROR', message: 'Internal server error.' };
  }
}
