import type { ClaudeHookEventType, ClaudeState } from '@ecc/shared';

/** One Claude Code process lifetime, identified by its Claude session ID. */
export interface ClaudeInstance {
  id: string;
  pane?: string;
  state: ClaudeState;
  lastEvent: ClaudeHookEventType;
  lastEventTs: number;
  lastActivityTs: number;
  /** The tool awaiting permission. Only that tool completing proves the request was resolved. */
  attentionTool?: string;
  attentionAgent?: string;
}

export interface NormalizedEvent {
  eventType: ClaudeHookEventType;
  ts: number;
  pane?: string;
  source?: string;
  notificationType?: string;
  toolName?: string;
  agentId?: string;
}

/** Notifications that mean Claude is waiting for the person, as documented for Claude Code. */
const ATTENTION_NOTIFICATIONS = new Set([
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_url_dialog',
  'agent_needs_input',
]);

function withoutAttention(instance: ClaudeInstance): void {
  instance.attentionTool = undefined;
  instance.attentionAgent = undefined;
}

/** Whether this event is a Notification type that says nothing about the lifecycle. */
export function isIrrelevantEvent(event: NormalizedEvent): boolean {
  return (
    event.eventType === 'Notification' &&
    event.notificationType !== 'idle_prompt' &&
    !ATTENTION_NOTIFICATIONS.has(event.notificationType ?? '')
  );
}

/**
 * Tool events prove activity, with two exceptions. A background subagent running after Stop must
 * not make an idle or offline Claude look busy. And a tool event must not clear a permission
 * request, unless it is the completion of the very tool that asked: tools can run in parallel.
 */
function applyToolEvent(instance: ClaudeInstance, event: NormalizedEvent): void {
  if (instance.state === 'needs_attention') {
    const completed = event.eventType !== 'PreToolUse';
    const sameTool = !instance.attentionTool || instance.attentionTool === event.toolName;
    if (completed && sameTool && instance.attentionAgent === event.agentId) {
      withoutAttention(instance);
      instance.state = 'working';
    }
    return;
  }
  if (!event.agentId) instance.state = 'working';
}

/** Applies an event to an instance. Ordering and deduplication are the caller's job. */
export function applyEvent(instance: ClaudeInstance, event: NormalizedEvent): void {
  switch (event.eventType) {
    case 'SessionStart':
      // Compaction happens inside a session, and says nothing about what Claude is doing.
      if (event.source !== 'compact') {
        withoutAttention(instance);
        instance.state = 'idle';
      }
      break;
    case 'UserPromptSubmit':
      withoutAttention(instance);
      instance.state = 'working';
      break;
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      applyToolEvent(instance, event);
      break;
    case 'PermissionRequest':
      instance.state = 'needs_attention';
      instance.attentionTool = event.toolName;
      instance.attentionAgent = event.agentId;
      break;
    case 'Notification':
      if (event.notificationType === 'idle_prompt') {
        withoutAttention(instance);
        instance.state = 'idle';
      } else if (instance.state !== 'needs_attention') {
        instance.state = 'needs_attention';
      }
      break;
    case 'Stop':
    case 'StopFailure':
      withoutAttention(instance);
      instance.state = 'idle';
      break;
    case 'SessionEnd':
      withoutAttention(instance);
      instance.state = 'offline';
      break;
  }
  instance.lastEvent = event.eventType;
  instance.lastEventTs = event.ts;
  instance.lastActivityTs = Math.max(instance.lastActivityTs, event.ts);
  if (event.pane) instance.pane = event.pane;
}
