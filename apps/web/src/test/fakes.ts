import { vi } from 'vitest';

/** Records what the application sends, and lets a test drive the server side of the socket. */
export class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
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
    FakeWebSocket.instances.push(this);
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
