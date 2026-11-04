import { act, renderHook } from '@testing-library/react';
import type { ClaudeSessionStatus, ClaudeState } from '@ecc/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeMonitorView } from '../services/claude-status';
import { FakeNotification } from '../test/fakes';
import { useAttentionNotifications } from './useAttentionNotifications';

function status(tmuxSession: string, state: ClaudeState): ClaudeSessionStatus {
  return { tmuxSession, state, monitored: true, reason: null, instanceCount: 1 };
}

function view(states: Record<string, ClaudeState>): ClaudeMonitorView {
  return {
    connected: true,
    ingestionAvailable: true,
    statuses: Object.fromEntries(
      Object.entries(states).map(([name, state]) => [name, status(name, state)]),
    ),
  };
}

const DISCONNECTED: ClaudeMonitorView = {
  connected: false,
  ingestionAvailable: true,
  statuses: {},
};

function setup(initial: ClaudeMonitorView = DISCONNECTED, viewing: string | null = null) {
  const onOpen = vi.fn();
  const hook = renderHook(
    (props: { monitor: ClaudeMonitorView; viewing: string | null }) =>
      useAttentionNotifications({ ...props, onOpen }),
    { initialProps: { monitor: initial, viewing } },
  );
  return {
    onOpen,
    ...hook,
    report: (monitor: ClaudeMonitorView, on: string | null = viewing) =>
      hook.rerender({ monitor, viewing: on }),
  };
}

async function turnOn(result: { current: { toggle: () => void } }) {
  await act(async () => {
    result.current.toggle();
    await Promise.resolve();
  });
  FakeNotification.instances.length = 0;
}

describe('useAttentionNotifications', () => {
  beforeEach(() => {
    window.localStorage.clear();
    FakeNotification.reset();
    vi.stubGlobal('Notification', FakeNotification);
    vi.stubGlobal('isSecureContext', true);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('page title', () => {
    it('counts sessions needing attention, and restores the title when none do', () => {
      const { report } = setup(view({ a: 'needs_attention', b: 'needs_attention', c: 'idle' }));
      expect(document.title).toBe('(2) Engineering Control Center');
      report(view({ a: 'working', b: 'idle', c: 'idle' }));
      expect(document.title).toBe('Engineering Control Center');
    });

    it('drops the count while disconnected, since nothing is known then', () => {
      const { report } = setup(view({ a: 'needs_attention' }));
      report(DISCONNECTED);
      expect(document.title).toBe('Engineering Control Center');
    });

    it('works without notification permission', () => {
      FakeNotification.permission = 'denied';
      setup(view({ a: 'needs_attention' }));
      expect(document.title).toBe('(1) Engineering Control Center');
    });
  });

  describe('turning on', () => {
    it('is off by default, and never prompts without a click', () => {
      const { result } = setup();
      expect(result.current.on).toBe(false);
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it('asks for permission, confirms with a notification, and remembers the choice', async () => {
      const { result, unmount } = setup();
      await act(async () => {
        result.current.toggle();
        await Promise.resolve();
      });
      expect(result.current.on).toBe(true);
      expect(FakeNotification.instances.map((n) => n.title)).toEqual(['Notifications are on']);

      unmount();
      expect(setup().result.current.on).toBe(true);
      expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    });

    it('stays off when the prompt is dismissed', async () => {
      FakeNotification.nextPermission = 'default';
      const { result } = setup();
      await turnOn(result);
      expect(result.current.on).toBe(false);
      expect(result.current.unavailableReason).toBeNull();
    });

    it('explains a blocked permission', async () => {
      FakeNotification.nextPermission = 'denied';
      const { result } = setup();
      await turnOn(result);
      expect(result.current.on).toBe(false);
      expect(result.current.unavailableReason).toMatch(/blocked/);
    });

    it('explains a browser that grants permission but refuses to show anything', async () => {
      FakeNotification.refuse = true;
      const { result } = setup();
      await turnOn(result);
      expect(result.current.on).toBe(false);
      expect(result.current.unavailableReason).toMatch(/refused/);
    });

    it('explains an insecure page, and does not prompt', async () => {
      vi.stubGlobal('isSecureContext', false);
      const { result } = setup();
      await turnOn(result);
      expect(result.current.unavailableReason).toMatch(/HTTPS or localhost/);
      expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it('explains a browser with no notifications', () => {
      vi.stubGlobal('Notification', undefined);
      expect(setup().result.current.unavailableReason).toMatch(/cannot show/);
    });

    it('notices a permission revoked in the browser settings', async () => {
      const { result } = setup();
      await turnOn(result);
      FakeNotification.permission = 'denied';
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(result.current.on).toBe(false);
    });
  });

  describe('announcing', () => {
    it('announces a session entering Needs Attention, naming only the session', async () => {
      const { result, report } = setup(view({ a: 'working' }));
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      expect(FakeNotification.instances).toHaveLength(1);
      expect(FakeNotification.instances[0].title).toBe('a needs attention');
      expect(FakeNotification.instances[0].options?.tag).toBe('ecc-attention-a');
    });

    it('announces nothing when off', () => {
      const { report } = setup(view({ a: 'working' }));
      report(view({ a: 'needs_attention' }));
      expect(FakeNotification.instances).toHaveLength(0);
    });

    it('does not announce what was already waiting when the page opened', async () => {
      const { result, report } = setup(view({ a: 'needs_attention' }));
      await turnOn(result);
      report(view({ a: 'needs_attention', b: 'idle' }));
      expect(FakeNotification.instances).toHaveLength(0);
    });

    it('does not announce again for updates that leave the state unchanged', async () => {
      const { result, report } = setup(view({ a: 'working' }));
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      report(view({ a: 'needs_attention' }));
      expect(FakeNotification.instances).toHaveLength(1);
    });

    it('announces again when a session returns to Needs Attention', async () => {
      const { result, report } = setup(view({ a: 'working' }));
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      report(view({ a: 'working' }));
      report(view({ a: 'needs_attention' }));
      expect(FakeNotification.instances).toHaveLength(2);
    });

    it('announces after a reconnect only what changed during the outage', async () => {
      const { result, report } = setup(view({ a: 'needs_attention', b: 'working' }));
      await turnOn(result);
      report(DISCONNECTED);
      report(view({ a: 'needs_attention', b: 'needs_attention' }));
      expect(FakeNotification.instances.map((n) => n.title)).toEqual(['b needs attention']);
    });

    it('keeps an alert open through an outage', async () => {
      const { result, report } = setup(view({ a: 'working' }));
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      report(DISCONNECTED);
      expect(FakeNotification.instances[0].closed).toBe(false);
    });

    it('stays quiet when you are looking at that session', async () => {
      vi.mocked(document.hasFocus).mockReturnValue(true);
      const { result, report } = setup(view({ a: 'working' }), 'a');
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      expect(FakeNotification.instances).toHaveLength(0);
    });

    it('announces another session while you look at a different one', async () => {
      vi.mocked(document.hasFocus).mockReturnValue(true);
      const { result, report } = setup(view({ a: 'working', b: 'working' }), 'a');
      await turnOn(result);
      report(view({ a: 'working', b: 'needs_attention' }));
      expect(FakeNotification.instances).toHaveLength(1);
    });

    it('announces the selected session when the window is not focused', async () => {
      const { result, report } = setup(view({ a: 'working' }), 'a');
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      expect(FakeNotification.instances).toHaveLength(1);
    });

    it('closes the alert once the session no longer needs attention', async () => {
      const { result, report } = setup(view({ a: 'working' }));
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      report(view({ a: 'working' }));
      expect(FakeNotification.instances[0].closed).toBe(true);
    });

    it('closes open alerts when turned off', async () => {
      const { result, report } = setup(view({ a: 'working' }));
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      const [alert] = FakeNotification.instances;
      await turnOn(result);
      expect(alert.closed).toBe(true);
      expect(result.current.on).toBe(false);
    });

    it('opens the session when the alert is clicked, sending nothing else', async () => {
      const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
      const { result, report, onOpen } = setup(view({ a: 'working' }));
      await turnOn(result);
      report(view({ a: 'needs_attention' }));
      FakeNotification.instances[0].onclick?.(new Event('click'));
      expect(focus).toHaveBeenCalled();
      expect(onOpen).toHaveBeenCalledWith('a');
      expect(FakeNotification.instances[0].closed).toBe(true);
    });

    it('survives a notification that cannot be shown', async () => {
      const { result, report } = setup(view({ a: 'working' }));
      await turnOn(result);
      FakeNotification.refuse = true;
      report(view({ a: 'needs_attention' }));
      expect(document.title).toBe('(1) Engineering Control Center');
      expect(result.current.on).toBe(false);
    });
  });
});
