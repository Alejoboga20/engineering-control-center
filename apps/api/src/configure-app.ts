import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { requestGuard, securityHeaders } from './common/request-guard';
import { AppConfig } from './config/app-config';

/** Everything that must apply identically in production and in HTTP tests. */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.disable('x-powered-by');
  app.use(requestGuard(config));
  app.use(securityHeaders);
  app.useBodyParser('json', { limit: '16kb' });
  app.enableCors({ origin: config.allowedOrigins, methods: ['GET', 'POST', 'DELETE'] });
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  serveWebApp(app, config.webDistPath);
}

/** Serves the compiled frontend from the same origin as the API, which suits SSH forwarding. */
function serveWebApp(app: NestExpressApplication, webDistPath: string): void {
  if (!existsSync(join(webDistPath, 'index.html'))) return;
  app.useStaticAssets(webDistPath);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const isApi = req.path === '/api' || req.path.startsWith('/api/');
    if (isApi || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next();
      return;
    }
    res.sendFile('index.html', { root: webDistPath });
  });
}
