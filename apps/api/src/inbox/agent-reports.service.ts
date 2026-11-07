import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { AgentReportResponse, InboxPriority } from '@ecc/shared';
import { InboxService, SourceEvent } from './inbox.service';

export interface HumanInputReport {
  title: string;
  description: string | null;
  priority: InboxPriority;
  sourceSession: string | null;
  sourceAgent: string | null;
  idempotencyKey?: string;
}

function normalizedTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Blockers that authenticated agents report. A retry never creates a second item: with an
 * idempotency key the key identifies the report; without one, the same title from the same
 * session updates the matching item, as long as that item is not resolved.
 */
@Injectable()
export class AgentReportsService {
  constructor(private readonly inbox: InboxService) {}

  reportHumanInput(report: HumanInputReport): AgentReportResponse {
    return this.inbox.run(() => {
      const where = report.sourceSession ? ` in session ${report.sourceSession}` : ' from an unknown session';
      const occurredAt = new Date().toISOString();
      const reported: SourceEvent = {
        kind: 'agent.reported',
        source: 'claude',
        summary: `Reported by an agent${where}.`,
        occurredAt,
      };

      if (report.idempotencyKey) {
        const sourceKey = `agent:report:${report.idempotencyKey}`;
        const eventKey = `agent:human_input:${report.idempotencyKey}`;
        if (this.inbox.hasEvent(eventKey)) {
          return { itemId: this.inbox.findByKey(sourceKey)?.id ?? null, created: false };
        }
        const result = this.inbox.applySource(sourceKey, () => ({
          ...this.fields(report),
          events: [{ ...reported, idempotencyKey: eventKey }],
        }));
        return { itemId: result?.item.id ?? null, created: result?.created ?? false };
      }

      const digest = createHash('sha256').update(normalizedTitle(report.title)).digest('hex');
      const base = `agent:report:${report.sourceSession ?? 'unknown'}:${digest}`;
      const family = this.inbox.findKeyFamily(base);
      const active = family.find((item) => item.status !== 'resolved');
      if (active) {
        const result = this.inbox.applySource(active.sourceKey, () => ({
          description: report.description ?? undefined,
          suggestedPriority: report.priority,
          events: [{ ...reported, kind: 'agent.reported_again', summary: `Reported again${where}.` }],
        }));
        return { itemId: result?.item.id ?? active.id, created: false };
      }
      // Every earlier item with this title was resolved: this is a new blocker, with a new key.
      const taken = new Set(family.map((item) => item.sourceKey));
      let sourceKey = base;
      for (let n = family.length + 1; taken.has(sourceKey); n += 1) sourceKey = `${base}:${n}`;
      const result = this.inbox.applySource(sourceKey, () => ({
        ...this.fields(report),
        events: [reported],
      }));
      return { itemId: result?.item.id ?? null, created: result?.created ?? false };
    });
  }

  private fields(report: HumanInputReport) {
    return {
      create: { type: 'human_input' as const, source: 'claude' as const },
      title: report.title,
      description: report.description,
      suggestedPriority: report.priority,
      sourceState: 'pending' as const,
      sourceSession: report.sourceSession,
      sourceAgent: report.sourceAgent,
    };
  }
}
