import { Injectable } from '@nestjs/common';
import type { PullRequestChecksState, PullRequestReviewState } from '@ecc/shared';

export const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';
const REQUEST_TIMEOUT_MS = 15_000;
/** When GitHub signals a limit without saying until when, as its documentation recommends. */
const DEFAULT_BACKOFF_MS = 60_000;
const ERROR_MESSAGE_MAX = 200;
/** A connection's maximum page size is 100. Smaller pages keep each query's cost low. */
export const PAGE_SIZE = 50;
/** Aliased lookups per query when reconciling pull requests that left the open list. */
export const LOOKUP_BATCH = 25;

/** What the Inbox needs of a pull request. The body is never requested. */
export interface GitHubPullRequest {
  repository: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  draft: boolean;
  state: 'open' | 'merged' | 'closed';
  createdAt: string;
  updatedAt: string;
  reviewState: PullRequestReviewState;
  checksState: PullRequestChecksState;
}

export interface OpenPullRequestPage {
  pullRequests: GitHubPullRequest[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export class GitHubRateLimitError extends Error {
  constructor(readonly until: Date) {
    super(`GitHub rate limit reached. Retrying after ${until.toISOString()}.`);
  }
}

export class GitHubApiError extends Error {}

const PR_FIELDS = `
  number title url isDraft state createdAt updatedAt
  author { login }
  reviewDecision
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
`;

const OPEN_PULL_REQUESTS = `
  query OpenPullRequests($owner: String!, $name: String!, $first: Int!, $after: String) {
    rateLimit { remaining resetAt }
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${PR_FIELDS} }
      }
    }
  }
`;

interface RawPullRequest {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  commits?: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

interface GraphQLResponse<T> {
  data?: T & { rateLimit?: { remaining: number; resetAt: string } };
  errors?: { type?: string; message?: string }[];
}

const REVIEW_STATES: Record<string, PullRequestReviewState> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

/** StatusState values: EXPECTED and PENDING are not finished, ERROR and FAILURE are failures. */
const CHECK_STATES: Record<string, PullRequestChecksState> = {
  SUCCESS: 'passing',
  FAILURE: 'failing',
  ERROR: 'failing',
  PENDING: 'pending',
  EXPECTED: 'pending',
};

export function toPullRequest(repository: string, raw: RawPullRequest): GitHubPullRequest {
  const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup;
  return {
    repository,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? null,
    draft: raw.isDraft,
    state: raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open',
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    reviewState: raw.reviewDecision ? (REVIEW_STATES[raw.reviewDecision] ?? 'unknown') : 'none',
    checksState: rollup ? (CHECK_STATES[rollup.state] ?? 'unknown') : 'none',
  };
}

function clipped(message: string): string {
  return message.length <= ERROR_MESSAGE_MAX ? message : `${message.slice(0, ERROR_MESSAGE_MAX - 1)}…`;
}

/**
 * Read-only GitHub GraphQL queries over the global fetch. The token is passed per call and only
 * ever placed in the Authorization header: never logged, never in an error message.
 */
@Injectable()
export class GitHubClient {
  /** Replaceable in tests. Production uses the global fetch. */
  fetch: typeof fetch = (...args) => globalThis.fetch(...args);
  /** Set when a successful response says the budget is spent. The caller backs off until then. */
  exhaustedUntil: Date | null = null;

  async openPullRequests(
    token: string,
    repository: string,
    after: string | null,
  ): Promise<OpenPullRequestPage> {
    const [owner, name] = repository.split('/');
    const data = await this.query<{
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: RawPullRequest[];
        };
      } | null;
    }>(token, OPEN_PULL_REQUESTS, { owner, name, first: PAGE_SIZE, after });
    if (!data.repository) throw new GitHubApiError(`Repository ${repository} was not found.`);
    const { pageInfo, nodes } = data.repository.pullRequests;
    return {
      pullRequests: nodes.map((node) => toPullRequest(repository, node)),
      hasNextPage: pageInfo.hasNextPage,
      endCursor: pageInfo.endCursor,
    };
  }

  /** Looks pull requests up by number, in one query. Missing ones are absent from the result. */
  async pullRequests(
    token: string,
    repository: string,
    numbers: number[],
  ): Promise<Map<number, GitHubPullRequest>> {
    const [owner, name] = repository.split('/');
    const aliases = numbers
      .map((number) => `pr${number}: pullRequest(number: ${Math.trunc(number)}) { ${PR_FIELDS} }`)
      .join('\n');
    const data = await this.query<{
      repository: Record<string, RawPullRequest | null> | null;
    }>(
      token,
      `query PullRequests($owner: String!, $name: String!) {
        rateLimit { remaining resetAt }
        repository(owner: $owner, name: $name) { ${aliases} }
      }`,
      { owner, name },
    );
    if (!data.repository) throw new GitHubApiError(`Repository ${repository} was not found.`);
    const found = new Map<number, GitHubPullRequest>();
    for (const raw of Object.values(data.repository)) {
      if (raw) found.set(raw.number, toPullRequest(repository, raw));
    }
    return found;
  }

  private async query<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(GITHUB_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/vnd.github+json',
          'User-Agent': 'engineering-control-center',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new GitHubApiError(`GitHub could not be reached: ${clipped((error as Error).message)}`);
    }

    const limitedUntil = this.rateLimitFromHeaders(response);
    if (limitedUntil && (!response.ok || response.headers.get('x-ratelimit-remaining') === '0')) {
      throw new GitHubRateLimitError(limitedUntil);
    }
    if (response.status === 401) {
      throw new GitHubApiError('GitHub rejected the token (401). Check ECC_GITHUB_TOKEN_FILE.');
    }
    if (response.status === 403 || response.status === 429) {
      // A secondary limit may come without headers. GitHub then recommends waiting a minute.
      const text = await response.text().catch(() => '');
      if (response.status === 429 || /rate limit/i.test(text)) {
        throw new GitHubRateLimitError(new Date(Date.now() + DEFAULT_BACKOFF_MS));
      }
      throw new GitHubApiError('GitHub refused the request (403). Check the token permissions.');
    }
    if (!response.ok) throw new GitHubApiError(`GitHub answered ${response.status}.`);

    let body: GraphQLResponse<T>;
    try {
      body = (await response.json()) as GraphQLResponse<T>;
    } catch {
      throw new GitHubApiError('GitHub returned a malformed response.');
    }
    if (body.errors?.some((error) => error.type === 'RATE_LIMITED')) {
      throw new GitHubRateLimitError(limitedUntil ?? new Date(Date.now() + DEFAULT_BACKOFF_MS));
    }
    if (body.errors?.length || !body.data) {
      const message = body.errors?.[0]?.message ?? 'no data';
      throw new GitHubApiError(`GitHub query failed: ${clipped(message)}`);
    }
    const { rateLimit } = body.data;
    if (rateLimit && rateLimit.remaining <= 0) {
      this.exhaustedUntil = new Date(rateLimit.resetAt);
    }
    return body.data;
  }

  /** When to try again, if the headers say so. */
  private rateLimitFromHeaders(response: Response): Date | null {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return new Date(Date.now() + retryAfter * 1000);
    if (response.headers.get('x-ratelimit-remaining') !== '0') return null;
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    return Number.isFinite(reset) && reset > 0
      ? new Date(reset * 1000)
      : new Date(Date.now() + DEFAULT_BACKOFF_MS);
  }
}
