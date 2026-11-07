import type { InboxItem } from '@ecc/shared';
import { describe, expect, it } from 'vitest';
import { compareInboxItems, isGitHubUrl, matchesInboxQuery, RESOLVED_VISIBLE_MS } from './inbox';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');

function item(fields: Partial<InboxItem>): InboxItem {
  return {
    id: 'a',
    type: 'human_input',
    title: 'Title',
    description: null,
    priority: 'P2',
    suggestedPriority: 'P2',
    priorityOverridden: false,
    status: 'open',
    source: 'claude',
    sourceState: 'pending',
    sourceSession: null,
    sourceAgent: null,
    pullRequest: null,
    revision: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    lastActivityAt: '2026-06-01T00:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
    resolution: null,
    ...fields,
  };
}

describe('inbox rules', () => {
  it('sorts by priority, then status, then newest activity', () => {
    const sorted = [
      item({ id: 'p2-resolved', status: 'resolved' }),
      item({ id: 'p2-old', lastActivityAt: '2026-05-01T00:00:00.000Z' }),
      item({ id: 'p3', priority: 'P3' }),
      item({ id: 'p2-acknowledged', status: 'acknowledged' }),
      item({ id: 'p2-new' }),
      item({ id: 'p1-resolved', priority: 'P1', status: 'resolved' }),
    ].sort(compareInboxItems);
    expect(sorted.map(({ id }) => id)).toEqual([
      'p1-resolved',
      'p2-new',
      'p2-old',
      'p2-acknowledged',
      'p2-resolved',
      'p3',
    ]);
  });

  it.each([
    ['needs_attention', item({ priority: 'P1' }), true],
    ['needs_attention', item({ priority: 'P1', status: 'acknowledged' }), false],
    ['needs_attention', item({ priority: 'P2' }), false],
    ['pull_requests', item({ type: 'pull_request' }), true],
    ['pull_requests', item({ type: 'pull_request', status: 'resolved' }), false],
    ['agent_blockers', item({ type: 'permission_request' }), true],
    ['agent_blockers', item({ type: 'agent_failure', status: 'acknowledged' }), true],
    ['agent_blockers', item({ type: 'pull_request' }), false],
    ['resolved', item({ status: 'resolved' }), true],
    ['resolved', item({}), false],
    ['all', item({ status: 'acknowledged' }), true],
    ['all', item({ status: 'resolved', resolvedAt: new Date(NOW - RESOLVED_VISIBLE_MS + 1000).toISOString() }), true],
    ['all', item({ status: 'resolved', resolvedAt: new Date(NOW - RESOLVED_VISIBLE_MS - 1000).toISOString() }), false],
  ] as const)('%s matches %j: %s', (filter, candidate, expected) => {
    expect(matchesInboxQuery(candidate, { filter }, NOW)).toBe(expected);
  });

  it('narrows by priority and status', () => {
    expect(matchesInboxQuery(item({}), { filter: 'all', priority: 'P1' }, NOW)).toBe(false);
    expect(matchesInboxQuery(item({}), { filter: 'all', status: 'acknowledged' }, NOW)).toBe(false);
    expect(matchesInboxQuery(item({}), { filter: 'all', priority: 'P2', status: 'open' }, NOW)).toBe(true);
  });

  it.each([
    ['https://github.com/acme/api/pull/1', true],
    ['http://github.com/acme/api/pull/1', false],
    ['https://github.com:8443/acme/api/pull/1', false],
    ['https://user@github.com/acme/api/pull/1', false],
    ['https://api.github.com/repos/acme/api', false],
    ['not a url', false],
    [null, false],
  ])('treats %s as a GitHub link: %s', (url, expected) => {
    expect(isGitHubUrl(url)).toBe(expected);
  });
});
