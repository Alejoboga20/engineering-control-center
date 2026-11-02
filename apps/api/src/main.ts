import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { configureApp } from './configure-app';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  if (process.getuid?.() === 0) {
    throw new Error('Refusing to run as root. Run the dashboard as an unprivileged user.');
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
    abortOnError: false,
  });
  const config = app.get<AppConfig>(APP_CONFIG);
  configureApp(app, config);

  // Lets SIGTERM from systemd close connections and PTY clients cleanly. tmux is left running.
  app.enableShutdownHooks();

  await app.listen(config.port, config.host);
  logger.log(`Listening on http://${config.host}:${config.port}`);
  logger.log(`Project roots: ${config.projectRoots.join(', ')}`);
  if (!LOOPBACK.has(config.host)) {
    logger.warn(
      `Bound to non-loopback address ${config.host}. There is no login: anyone who reaches this port gets a shell.`,
    );
  }
}

bootstrap().catch((error: Error) => {
  console.error(`Failed to start: ${error.message}`);
  process.exit(1);
});
