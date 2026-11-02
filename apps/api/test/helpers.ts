import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { WebSocket } from 'ws';
import { AppModule } from '../src/app.module';
import { APP_CONFIG, AppConfig } from '../src/config/app-config';
import { configureApp } from '../src/configure-app';

export const TEST_ORIGIN = 'http://localhost:4999';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    projectRoots: [],
    allowedOrigins: [TEST_ORIGIN],
    allowedHosts: ['localhost:4999'],
    tmuxBin: 'tmux',
    webDistPath: '/nonexistent',
    ...overrides,
  };
}

export interface RunningApp {
  app: NestExpressApplication;
  port: number;
}

/** Boots the real module graph and middleware on an ephemeral port, with selected overrides. */
export async function startApp(
  config: AppConfig,
  overrides: { token: Parameters<TestingModuleBuilder['overrideProvider']>[0]; value: unknown }[] = [],
): Promise<RunningApp> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config);
  for (const { token, value } of overrides) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  configureApp(app, config);
  await app.listen(0, '127.0.0.1');
  return { app, port: (app.getHttpServer().address() as AddressInfo).port };
}

export interface TestClient {
  ws: WebSocket;
  messages: Record<string, unknown>[];
  output(): string;
  closed: Promise<{ code: number }>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  send(message: unknown): void;
}

/** Host and Origin are set explicitly, as a browser on the allowed origin would send them. */
export function connect(port: number, path: string, origin: string | null = TEST_ORIGIN): TestClient {
  const headers: Record<string, string> = { Host: 'localhost:4999' };
  if (origin) headers.Origin = origin;
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const messages: Record<string, unknown>[] = [];
  let outputBytes = Buffer.alloc(0);
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (isBinary) outputBytes = Buffer.concat([outputBytes, data]);
    else messages.push(JSON.parse(data.toString()));
  });
  ws.on('error', () => undefined);
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.on('close', (code) => resolve({ code }));
  });
  return {
    ws,
    messages,
    closed,
    output: () => outputBytes.toString('utf8'),
    send: (message) => ws.send(JSON.stringify(message)),
    waitFor: (predicate, timeoutMs = 5000) => waitUntil(predicate, timeoutMs),
  };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
