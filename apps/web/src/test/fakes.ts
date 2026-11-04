import { vi } from 'vitest';

/** Records what the application sends, and lets a test drive the server side of the socket. */
export class FakeWebSocket {
  static readonly OPEN = 1;
  /** Terminal sockets. The Claude monitor socket, open throughout, is kept apart in `monitors`. */
  static instances: FakeWebSocket[] = [];
  static monitors: FakeWebSocket[] = [];
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  }

  readyState = 0;
  binaryType = 'blob';
  sent: string[] = [];
  closeCalls = 0;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    (url.includes('/api/claude/events') ? FakeWebSocket.monitors : FakeWebSocket.instances).push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls++;
    this.readyState = 3;
  }

  // Test controls
  serverReady() {
    this.readyState = FakeWebSocket.OPEN;
    this.serverSend({ type: 'ready', session: 'alpha', cols: 80, rows: 24 });
  }
  serverSend(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  serverOutput(bytes: Uint8Array) {
    this.onmessage?.({ data: bytes.buffer });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Stands in for the browser's Notification API, which jsdom lacks. */
export class FakeNotification {
  static permission: NotificationPermission = 'default';
  /** The answer to the next permission prompt. */
  static nextPermission: NotificationPermission = 'granted';
  /** Mimics Android browsers, which grant permission and then throw from the constructor. */
  static refuse = false;
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = FakeNotification.nextPermission;
    return FakeNotification.permission;
  });

  static reset() {
    FakeNotification.permission = 'default';
    FakeNotification.nextPermission = 'granted';
    FakeNotification.refuse = false;
    FakeNotification.instances = [];
    FakeNotification.requestPermission.mockClear();
  }

  closed = false;
  onclick: ((event: Event) => void) | null = null;

  constructor(
    readonly title: string,
    readonly options?: NotificationOptions,
  ) {
    if (FakeNotification.refuse) throw new TypeError('Illegal constructor');
    FakeNotification.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

export const terminals: FakeTerminal[] = [];

export class FakeTerminal {
  cols = 80;
  rows = 24;
  options: Record<string, unknown> = {};
  disposed = false;
  writes: Uint8Array[] = [];
  resets = 0;
  private dataListener: ((data: string) => void) | null = null;
  private resizeListener: ((size: { cols: number; rows: number }) => void) | null = null;
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  wheelHandler: ((event: WheelEvent) => boolean) | null = null;
  csiHandler: ((params: (number | number[])[]) => boolean) | null = null;
  oscHandler: ((data: string) => boolean) | null = null;
  parser = {
    registerCsiHandler: (
      _id: { prefix?: string; final: string },
      handler: (params: (number | number[])[]) => boolean,
    ) => {
      this.csiHandler = handler;
      return { dispose: () => {} };
    },
    registerOscHandler: (_code: number, handler: (data: string) => boolean) => {
      this.oscHandler = handler;
      return { dispose: () => {} };
    },
  };
  element = document.createElement('div');
  loadAddon = vi.fn();
  open = vi.fn();
  focus = vi.fn();
  hasSelection = vi.fn(() => false);
  getSelection = vi.fn(() => '');

  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
    terminals.push(this);
  }
  write(data: Uint8Array) {
    this.writes.push(data);
  }
  reset() {
    this.resets++;
  }
  dispose() {
    this.disposed = true;
  }
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = null) };
  }
  onResize(listener: (size: { cols: number; rows: number }) => void) {
    this.resizeListener = listener;
    return { dispose: () => (this.resizeListener = null) };
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  attachCustomWheelEventHandler(handler: (event: WheelEvent) => boolean) {
    this.wheelHandler = handler;
  }
  input(data: string) {
    this.dataListener?.(data);
  }
  type(data: string) {
    this.dataListener?.(data);
  }
  emitResize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.resizeListener?.({ cols, rows });
  }
}

export function installBrowserFakes() {
  FakeWebSocket.instances = [];
  FakeWebSocket.monitors = [];
  terminals.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
}
