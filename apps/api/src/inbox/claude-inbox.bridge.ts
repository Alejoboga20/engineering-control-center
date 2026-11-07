import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import type { ClaudeSessionStatus, InboxItemType } from '@ecc/shared';
import {
  AcceptedClaudeEvent,
  ClaudeStateService,
} from '../claude-monitoring/claude-state.service';
import { InboxService, SourceUpdate } from './inbox.service';
import type { StoredItem } from './inbox.repository';

/** Notifications that ask the person for input other than a permission. */
const INPUT_NOTIFICATIONS = new Set(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
/** Events after which no permission or input prompt of that instance can still be open. */
const ENDS_PROMPTS = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);

type ClaudeItemType = Exclude<InboxItemType, 'pull_request'>;

const KEY_KIND: Record<ClaudeItemType, string> = {
  permission_request: 'permission',
  human_input: 'input',
  agent_failure: 'failure',
};

export function claudeSourceKey(type: ClaudeItemType, tmuxSession: string, claudeSessionId: string) {
  return `claude:${KEY_KIND[type]}:${tmuxSession}:${claudeSessionId}`;
}

/**
 * Turns accepted Claude Code hook events into Inbox items: one item per Claude instance and kind
 * of blocker, however many events repeat it. Items are cleared only by the signals that end
 * Needs Attention in monitoring. Where nothing reliable is known, the item becomes `uncertain`,
 * never silently resolved. Prompts and tool arguments never reach this class.
 */
@Injectable()
export class ClaudeInboxBridge implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ClaudeInboxBridge.name);
  private readonly unsubscribe: (() => void)[] = [];

  constructor(
    private readonly state: ClaudeStateService,
    private readonly inbox: InboxService,
  ) {}

  /** Runs before the server accepts requests, so no new event can race the restart sweep. */
  onModuleInit(): void {
    if (!this.inbox.available) return;
    this.markUncertain(
      this.safely(() => this.inboxPending({})),
      'The backend restarted, so whether the prompt is still open is unknown.',
    );
    this.unsubscribe.push(
      this.state.onEvent((event) => this.handleEvent(event)),
      this.state.onChange((status) => this.handleStatus(status)),
    );
  }

  onApplicationShutdown(): void {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }

  handleEvent(accepted: AcceptedClaudeEvent): void {
    if (!this.inbox.available) return;
    this.safely(() => this.inbox.run(() => this.apply(accepted)));
  }

  handleStatus(status: ClaudeSessionStatus): void {
    if (!this.inbox.available) return;
    if (!status.monitored) {
      this.markUncertain(
        this.safely(() => this.inboxPending({ session: status.tmuxSession })),
        'The tmux session is gone, so whether the prompt is still open is unknown.',
      );
    } else if (status.reason === 'stale') {
      this.markUncertain(
        this.safely(() => this.inboxPending({ session: status.tmuxSession })),
        'No recent event from this session, so whether the prompt is still open is unknown.',
      );
    }
  }

  private apply({ request, ts, previousState, state, superseded }: AcceptedClaudeEvent): void {
    const at = new Date(ts).toISOString();
    const { eventType, tmuxSession, eventId } = request;
    const raise = (
      type: ClaudeItemType,
      update: Omit<SourceUpdate, 'events'>,
      kind: string,
      summary: string,
    ) => this.raise(type, request, at, update, { kind, summary });

    // Clearing comes first: StopFailure ends any open prompt, then raises its own item.
    const leftAttention = previousState === 'needs_attention' && state !== 'needs_attention';
    const restarted = eventType === 'SessionStart' && request.source !== 'compact';
    if (leftAttention || restarted || ENDS_PROMPTS.has(eventType)) {
      this.clear('permission_request', request, at);
      this.clear('human_input', request, at);
    }
    if (eventType === 'UserPromptSubmit' || restarted) this.clear('agent_failure', request, at);

    if (eventType === 'PermissionRequest') {
      const tool = request.toolName ? ` to use ${request.toolName}` : '';
      raise(
        'permission_request',
        { title: `Claude in ${tmuxSession} is waiting for permission${tool}`, suggestedPriority: 'P1' },
        'permission.requested',
        `Permission requested${request.toolName ? ` for ${request.toolName}` : ''}${this.by(request.agentId)}.`,
      );
    } else if (eventType === 'Notification' && request.notificationType === 'permission_prompt') {
      // Usually follows PermissionRequest, so it keeps that title, which names the tool.
      raise(
        'permission_request',
        {
          title: this.hasItem('permission_request', request)
            ? undefined
            : `Claude in ${tmuxSession} is waiting for permission`,
          suggestedPriority: 'P1',
        },
        'permission.prompt_shown',
        'Claude Code showed a permission prompt.',
      );
    } else if (eventType === 'Notification' && INPUT_NOTIFICATIONS.has(request.notificationType ?? '')) {
      raise(
        'human_input',
        { title: `Claude in ${tmuxSession} is waiting for input`, suggestedPriority: 'P1' },
        'input.requested',
        `Claude Code notification: ${request.notificationType}${this.by(request.agentId)}.`,
      );
    } else if (eventType === 'StopFailure') {
      raise(
        'agent_failure',
        { title: `Claude in ${tmuxSession} stopped on an API error`, suggestedPriority: 'P2' },
        'agent.failed',
        'The turn ended because of an API error (StopFailure).',
      );
    }

    if (superseded.length > 0) {
      const reason = `A new Claude Code started in the same pane (event ${eventId}).`;
      for (const agent of superseded) {
        this.markUncertain(this.inboxPending({ session: tmuxSession, agent }), reason);
      }
    }
  }

  /**
   * A new request is a new actionable condition only if the previous one was cleared, uncertain
   * or resolved. A repeat while it is still pending updates the item and keeps its status.
   */
  private raise(
    type: ClaudeItemType,
    request: AcceptedClaudeEvent['request'],
    at: string,
    update: Omit<SourceUpdate, 'events'>,
    event: { kind: string; summary: string },
  ): void {
    const key = claudeSourceKey(type, request.tmuxSession, request.claudeSessionId);
    const recorded = {
      ...event,
      source: 'claude' as const,
      occurredAt: at,
      idempotencyKey: `hook:${request.eventId}:${KEY_KIND[type]}`,
    };
    this.inbox.applySource(key, (current) => {
      if (current && at < current.lastActivityAt) return { events: [recorded] };
      const isNew = current !== null && (current.status === 'resolved' || current.sourceState !== 'pending');
      return {
        ...update,
        create: { type, source: 'claude' },
        sourceState: 'pending',
        sourceSession: request.tmuxSession,
        sourceAgent: request.claudeSessionId,
        reopen: isNew,
        events: [recorded],
      };
    });
  }

  private clear(type: ClaudeItemType, request: AcceptedClaudeEvent['request'], at: string): void {
    const key = claudeSourceKey(type, request.tmuxSession, request.claudeSessionId);
    this.inbox.applySource(key, (current) => {
      if (!current || current.sourceState === 'cleared' || at < current.lastActivityAt) return null;
      return {
        sourceState: 'cleared',
        resolve: 'auto_cleared',
        events: [
          {
            kind: 'source.cleared',
            source: 'claude',
            summary: `Cleared by ${request.eventType}.`,
            occurredAt: at,
            idempotencyKey: `hook:${request.eventId}:${KEY_KIND[type]}`,
          },
        ],
      };
    });
  }

  private markUncertain(items: StoredItem[] | null, reason: string): void {
    if (!items || items.length === 0) return;
    const now = new Date().toISOString();
    this.safely(() =>
      this.inbox.run(() => {
        for (const item of items) {
          this.inbox.applySource(item.sourceKey, (current) =>
            current?.sourceState === 'pending'
              ? {
                  sourceState: 'uncertain',
                  events: [{ kind: 'source.uncertain', source: 'system', summary: reason, occurredAt: now }],
                }
              : null,
          );
        }
      }),
    );
  }

  private hasItem(type: ClaudeItemType, request: AcceptedClaudeEvent['request']): boolean {
    return this.inbox.findByKey(claudeSourceKey(type, request.tmuxSession, request.claudeSessionId)) !== null;
  }

  private inboxPending(filter: { session?: string; agent?: string }): StoredItem[] {
    return this.inbox.pendingClaudeItems(filter);
  }

  private by(agentId: string | undefined): string {
    return agentId ? ` by subagent ${agentId}` : '';
  }

  /** The Inbox must never break monitoring: failures are logged and dropped. */
  private safely<T>(work: () => T): T | null {
    try {
      return work();
    } catch (error) {
      this.logger.warn(`Could not update the Inbox from a Claude event: ${(error as Error).message}`);
      return null;
    }
  }
}
