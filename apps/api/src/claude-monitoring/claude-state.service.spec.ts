import type { ClaudeHookEventRequest, ClaudeHookEventType, ClaudeSessionStatus } from '@ecc/shared';
import type { TmuxService } from '../tmux/tmux.service';
import { CLAUDE_LIMITS, CLAUDE_STALE_AFTER_MS, ClaudeStateService } from './claude-state.service';

const T0 = Date.parse('2026-11-03T12:00:00.000Z');

describe('ClaudeStateService', () => {
  let state: ClaudeStateService;
  let listSessions: jest.Mock;
  let nextId: number;
  let clock: number;

  /** Sends an event, each one second after the previous by default. */
  function send(
    eventType: ClaudeHookEventType,
    { at, ...rest }: Partial<ClaudeHookEventRequest> & { at?: number } = {},
  ): boolean {
    clock = at ?? clock + 1000;
    return state.record(
      {
        eventId: `event-${nextId++}`,
        claudeSessionId: 'claude-1',
        tmuxSession: 'payroll',
        eventType,
        timestamp: new Date(clock).toISOString(),
        pane: '%1',
        ...rest,
      },
      clock,
    );
  }

  const status = (name = 'payroll'): ClaudeSessionStatus => state.statusOf(name, clock);

  beforeEach(() => {
    listSessions = jest.fn().mockResolvedValue([]);
    state = new ClaudeStateService({ listSessions } as unknown as TmuxService);
    nextId = 0;
    clock = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('transitions', () => {
    it('is Unknown with no events, without claiming to be monitored', () => {
      expect(status('never-seen')).toEqual({
        tmuxSession: 'never-seen',
        state: 'unknown',
        monitored: false,
        reason: 'no-events',
        instanceCount: 0,
      });
    });

    it('does not call a session Working because Claude started', () => {
      send('SessionStart', { source: 'startup' });
      expect(status().state).toBe('idle');
    });

    it('marks Working on a submitted prompt', () => {
      send('SessionStart', { source: 'startup' });
      send('UserPromptSubmit');
      expect(status().state).toBe('working');
    });

    it('marks Idle on Stop, and on a turn ended by an API error', () => {
      send('UserPromptSubmit');
      send('Stop');
      expect(status().state).toBe('idle');
      send('UserPromptSubmit');
      send('StopFailure');
      expect(status().state).toBe('idle');
    });

    it('marks Offline on SessionEnd', () => {
      send('UserPromptSubmit');
      send('SessionEnd');
      expect(status()).toMatchObject({ state: 'offline', instanceCount: 0, reason: null });
    });

    it('marks Needs Attention on PermissionRequest', () => {
      send('UserPromptSubmit');
      send('PermissionRequest', { toolName: 'Bash' });
      expect(status().state).toBe('needs_attention');
    });

    it('takes a tool event as evidence of work when nothing else is known', () => {
      send('PostToolUse', { toolName: 'Read' });
      expect(status().state).toBe('working');
    });

    it('leaves the state alone when compaction restarts a session', () => {
      send('UserPromptSubmit');
      send('SessionStart', { source: 'compact' });
      expect(status().state).toBe('working');
    });

    it('reports an instance whose only event says nothing as Unknown, but monitored', () => {
      send('SessionStart', { source: 'compact' });
      expect(status()).toMatchObject({
        state: 'unknown',
        monitored: true,
        reason: 'insufficient-events',
      });
    });
  });

  describe('permission requests', () => {
    beforeEach(() => {
      send('UserPromptSubmit');
      send('PreToolUse', { toolName: 'Bash' });
      send('PermissionRequest', { toolName: 'Bash' });
    });

    it('is resolved when the tool that asked completes', () => {
      send('PostToolUse', { toolName: 'Bash' });
      expect(status().state).toBe('working');
    });

    it('is resolved when the tool that asked fails', () => {
      send('PostToolUseFailure', { toolName: 'Bash' });
      expect(status().state).toBe('working');
    });

    it('survives another tool completing in parallel', () => {
      send('PostToolUse', { toolName: 'Read' });
      expect(status().state).toBe('needs_attention');
    });

    it('survives the same tool starting again in parallel', () => {
      send('PreToolUse', { toolName: 'Bash' });
      expect(status().state).toBe('needs_attention');
    });

    it('survives a subagent completing the same kind of tool', () => {
      send('PostToolUse', { toolName: 'Bash', agentId: 'sub-1' });
      expect(status().state).toBe('needs_attention');
    });

    it('is superseded by a new prompt, since a denial sends no hook at all', () => {
      send('UserPromptSubmit');
      expect(status().state).toBe('working');
    });

    it('is superseded by Stop and SessionEnd', () => {
      send('Stop');
      expect(status().state).toBe('idle');
      send('PermissionRequest', { toolName: 'Bash' });
      send('SessionEnd');
      expect(status().state).toBe('offline');
    });
  });

  describe('notifications', () => {
    it.each(['permission_prompt', 'elicitation_dialog', 'agent_needs_input'])(
      'maps %s to Needs Attention',
      (notificationType) => {
        send('UserPromptSubmit');
        send('Notification', { notificationType });
        expect(status().state).toBe('needs_attention');
      },
    );

    it('treats idle_prompt as Idle, not as a request for attention', () => {
      send('UserPromptSubmit');
      send('Notification', { notificationType: 'idle_prompt' });
      expect(status().state).toBe('idle');
    });

    it.each(['auth_success', 'plugin_notification', undefined])('ignores %s', (notificationType) => {
      send('UserPromptSubmit');
      expect(send('Notification', { notificationType })).toBe(false);
      expect(status()).toMatchObject({ state: 'working', lastEvent: 'UserPromptSubmit' });
    });

    it('keeps the pending tool when the notification follows the permission request', () => {
      send('PermissionRequest', { toolName: 'Bash' });
      send('Notification', { notificationType: 'permission_prompt' });
      send('PostToolUse', { toolName: 'Read' });
      expect(status().state).toBe('needs_attention');
      send('PostToolUse', { toolName: 'Bash' });
      expect(status().state).toBe('working');
    });
  });

  describe('subagents', () => {
    it('do not make an idle Claude look busy, but do count as activity', () => {
      send('Stop');
      const before = status().lastActivityAt;
      send('PreToolUse', { toolName: 'Read', agentId: 'sub-1' });
      expect(status().state).toBe('idle');
      expect(status().lastActivityAt).not.toBe(before);
    });

    it('can request attention, and clear it by completing that tool', () => {
      send('UserPromptSubmit');
      send('PermissionRequest', { toolName: 'Bash', agentId: 'sub-1' });
      expect(status().state).toBe('needs_attention');
      send('PostToolUse', { toolName: 'Bash', agentId: 'sub-1' });
      expect(status().state).toBe('working');
    });
  });

  describe('ordering and duplicates', () => {
    it('applies a repeated event ID once', () => {
      expect(send('UserPromptSubmit', { eventId: 'same' })).toBe(true);
      expect(send('Stop', { eventId: 'same' })).toBe(false);
      expect(status().state).toBe('working');
    });

    it('never lets an older event overwrite a newer state', () => {
      send('Stop', { at: T0 + 5000 });
      expect(send('UserPromptSubmit', { at: T0 + 2000 })).toBe(false);
      expect(status()).toMatchObject({ state: 'idle', lastEvent: 'Stop' });
    });

    it('does not revive an ended session with an event from the same instant', () => {
      send('SessionEnd', { at: T0 + 5000 });
      expect(send('PostToolUse', { at: T0 + 5000 })).toBe(false);
      expect(status().state).toBe('offline');
    });

    it('applies events from the same instant in arrival order otherwise', () => {
      send('UserPromptSubmit', { at: T0 + 5000 });
      expect(send('Stop', { at: T0 + 5000 })).toBe(true);
      expect(status().state).toBe('idle');
    });

    it('does not depend on the order of instances that are unrelated', () => {
      send('Stop', { at: T0 + 5000, claudeSessionId: 'a', tmuxSession: 'one' });
      send('UserPromptSubmit', { at: T0 + 1000, claudeSessionId: 'b', tmuxSession: 'two' });
      expect(state.statusOf('one', T0 + 5000).state).toBe('idle');
      expect(state.statusOf('two', T0 + 5000).state).toBe('working');
    });
  });

  describe('staleness', () => {
    const working = CLAUDE_STALE_AFTER_MS.working as number;

    it('never shows Working on an old event, and never turns it into Idle', () => {
      send('UserPromptSubmit');
      clock += working - 1;
      expect(status().state).toBe('working');
      clock += 2;
      expect(status()).toMatchObject({ state: 'unknown', reason: 'stale', monitored: true });
    });

    it('recovers on the next event', () => {
      send('UserPromptSubmit');
      clock += working + 1;
      send('PostToolUse');
      expect(status()).toMatchObject({ state: 'working', reason: null });
    });

    it('keeps an attention signal much longer than Working', () => {
      send('PermissionRequest', { toolName: 'Bash' });
      clock += working * 2;
      expect(status().state).toBe('needs_attention');
      clock += CLAUDE_STALE_AFTER_MS.needs_attention as number;
      expect(status()).toMatchObject({ state: 'unknown', reason: 'stale' });
    });

    it('publishes the change to Unknown from the sweep, with no event to trigger it', async () => {
      const seen: ClaudeSessionStatus[] = [];
      send('UserPromptSubmit');
      listSessions.mockResolvedValue([{ name: 'payroll', createdAt: new Date(T0 - 1000) }]);
      state.onChange((changed) => seen.push(changed));
      clock += working + 1;
      await state.sweep();
      expect(seen.at(-1)).toMatchObject({ tmuxSession: 'payroll', state: 'unknown', reason: 'stale' });
    });
  });

  describe('concurrent and restarted instances', () => {
    it('reports Unknown when two instances run in different panes', () => {
      send('UserPromptSubmit', { claudeSessionId: 'a', pane: '%1' });
      send('Stop', { claudeSessionId: 'b', pane: '%2' });
      expect(status()).toMatchObject({
        state: 'unknown',
        reason: 'multiple-instances',
        instanceCount: 2,
      });
    });

    it('still surfaces a request for attention from either instance', () => {
      send('UserPromptSubmit', { claudeSessionId: 'a', pane: '%1' });
      send('PermissionRequest', { claudeSessionId: 'b', pane: '%2', toolName: 'Bash' });
      expect(status()).toMatchObject({
        state: 'needs_attention',
        reason: 'multiple-instances',
        claudeSessionId: 'b',
      });
    });

    it('returns to one-to-one when the other instance ends', () => {
      send('UserPromptSubmit', { claudeSessionId: 'a', pane: '%1' });
      send('Stop', { claudeSessionId: 'b', pane: '%2' });
      send('SessionEnd', { claudeSessionId: 'b', pane: '%2' });
      expect(status()).toMatchObject({ state: 'working', reason: null, instanceCount: 1 });
    });

    it('treats a new Claude in the same pane as a restart, even without SessionEnd', () => {
      send('UserPromptSubmit', { claudeSessionId: 'old' });
      send('SessionStart', { claudeSessionId: 'new', source: 'startup' });
      expect(status()).toMatchObject({ state: 'idle', claudeSessionId: 'new', instanceCount: 1 });
    });

    it('handles /clear, which ends one session ID and starts another', () => {
      send('UserPromptSubmit', { claudeSessionId: 'old' });
      send('SessionEnd', { claudeSessionId: 'old' });
      send('SessionStart', { claudeSessionId: 'new', source: 'clear' });
      expect(status()).toMatchObject({ state: 'idle', claudeSessionId: 'new', instanceCount: 1 });
    });

    it('reports multiple instances when a Claude behind a nested one comes back', () => {
      send('UserPromptSubmit', { claudeSessionId: 'parent' });
      send('SessionStart', { claudeSessionId: 'child', source: 'startup' });
      send('PostToolUse', { claudeSessionId: 'parent', toolName: 'Bash' });
      expect(status()).toMatchObject({ state: 'unknown', reason: 'multiple-instances' });
    });

    it('stops counting an instance that went stale, such as one killed without notice', () => {
      send('UserPromptSubmit', { claudeSessionId: 'killed', pane: '%1' });
      clock += (CLAUDE_STALE_AFTER_MS.working as number) + 1;
      send('Stop', { claudeSessionId: 'live', pane: '%2' });
      expect(status()).toMatchObject({ state: 'idle', claudeSessionId: 'live', instanceCount: 1 });
    });
  });

  describe('tmux reconciliation', () => {
    it('reports every tmux session, with Unknown for those without events', async () => {
      send('UserPromptSubmit');
      listSessions.mockResolvedValue([
        { name: 'payroll', createdAt: new Date(T0 - 1000) },
        { name: 'manual', createdAt: new Date(T0 - 1000) },
      ]);
      const sessions = await state.snapshot();
      expect(sessions.map((session) => [session.tmuxSession, session.state])).toEqual([
        ['payroll', 'working'],
        ['manual', 'unknown'],
      ]);
    });

    it('omits and forgets events for a session that does not exist in tmux', async () => {
      send('UserPromptSubmit', { tmuxSession: 'ghost' });
      await expect(state.snapshot()).resolves.toEqual([]);
      expect(status('ghost').monitored).toBe(false);
    });

    it('does not apply old events to a new session that reuses the name', async () => {
      send('UserPromptSubmit');
      listSessions.mockResolvedValue([{ name: 'payroll', createdAt: new Date(clock + 60_000) }]);
      clock += 120_000;
      const [session] = await state.snapshot();
      expect(session).toMatchObject({ state: 'unknown', monitored: false });
    });

    it('publishes Unknown when a session disappears', async () => {
      const seen: ClaudeSessionStatus[] = [];
      send('UserPromptSubmit');
      state.onChange((changed) => seen.push(changed));
      await state.sweep();
      expect(seen.at(-1)).toMatchObject({ tmuxSession: 'payroll', monitored: false });
    });

    it('does not run tmux from the sweep while nothing is monitored', async () => {
      await state.sweep();
      expect(listSessions).not.toHaveBeenCalled();
    });

    it('keeps running when tmux fails during a sweep', async () => {
      send('UserPromptSubmit');
      listSessions.mockRejectedValue(new Error('tmux failed'));
      await expect(state.sweep()).resolves.toBeUndefined();
      expect(status().state).toBe('working');
    });
  });

  describe('publishing', () => {
    it('publishes state changes immediately, and coalesces activity-only updates', () => {
      const seen: ClaudeSessionStatus[] = [];
      state.onChange((changed) => seen.push(changed));
      send('UserPromptSubmit', { at: T0 });
      send('PreToolUse', { at: T0 + 100 });
      send('PostToolUse', { at: T0 + 200 });
      expect(seen.map((changed) => changed.lastEvent)).toEqual(['UserPromptSubmit']);
      send('PermissionRequest', { at: T0 + 300 });
      expect(seen.at(-1)?.state).toBe('needs_attention');
      send('PostToolUse', { at: T0 + 400 });
      send('PreToolUse', { at: T0 + 6000 });
      expect(seen.at(-1)?.lastEvent).toBe('PreToolUse');
    });

    it('stops notifying a removed listener', () => {
      const listener = jest.fn();
      state.onChange(listener)();
      send('UserPromptSubmit');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('bounds', () => {
    it('limits tracked sessions, evicting the least recently active', () => {
      for (let i = 0; i <= CLAUDE_LIMITS.maxSessions; i++) {
        send('UserPromptSubmit', { tmuxSession: `s${i}` });
      }
      expect(status('s0').monitored).toBe(false);
      expect(status(`s${CLAUDE_LIMITS.maxSessions}`).monitored).toBe(true);
    });

    it('limits instances in a session, evicting ended ones first', () => {
      send('UserPromptSubmit', { claudeSessionId: 'keep', pane: '%0' });
      for (let i = 0; i < CLAUDE_LIMITS.maxInstancesPerSession; i++) {
        send('SessionEnd', { claudeSessionId: `ended${i}`, pane: `%${i + 1}` });
      }
      expect(status()).toMatchObject({ state: 'working', claudeSessionId: 'keep' });
    });

    it('remembers a bounded number of event IDs', () => {
      send('UserPromptSubmit', { eventId: 'first' });
      for (let i = 0; i < CLAUDE_LIMITS.maxRememberedEventIds; i++) send('PreToolUse');
      expect(send('Stop', { eventId: 'first' })).toBe(true);
    });
  });
});
