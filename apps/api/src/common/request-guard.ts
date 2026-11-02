import type { IncomingHttpHeaders } from 'node:http';
import type { ApiErrorResponse } from '@ecc/shared';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config/app-config';

type AccessConfig = Pick<AppConfig, 'allowedHosts' | 'allowedOrigins'>;

/**
 * Host validation defeats DNS rebinding, where a hostile page makes its own domain resolve to
 * 127.0.0.1 so the browser treats this server as same-origin.
 */
export function isHostAllowed(headers: IncomingHttpHeaders, config: AccessConfig): boolean {
  const host = headers.host?.toLowerCase();
  return host !== undefined && config.allowedHosts.includes(host);
}

export function isOriginAllowed(origin: string, config: AccessConfig): boolean {
  return config.allowedOrigins.includes(origin);
}

/**
 * WebSocket upgrades are not subject to the same-origin policy, so a browser Origin header is
 * mandatory here. Without this check any website could open a shell on this machine.
 */
export function isUpgradeAllowed(headers: IncomingHttpHeaders, config: AccessConfig): boolean {
  return (
    isHostAllowed(headers, config) &&
    headers.origin !== undefined &&
    isOriginAllowed(headers.origin, config)
  );
}

/**
 * Applied to all HTTP requests. Origin is optional because browsers omit it on same-origin GET
 * requests, but they always send it on the state-changing POST and DELETE requests that a
 * cross-site page could otherwise trigger.
 */
export function requestGuard(config: AccessConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { origin } = req.headers;
    if (isHostAllowed(req.headers, config) && (!origin || isOriginAllowed(origin, config))) {
      next();
      return;
    }
    const body: ApiErrorResponse = {
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'Host or Origin is not allowed. See ECC_ALLOWED_ORIGINS.',
    };
    res.status(403).json(body);
  };
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
}
