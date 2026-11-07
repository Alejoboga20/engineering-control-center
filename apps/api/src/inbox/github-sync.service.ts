import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  INBOX_LIMITS,
  type AgentReportResponse,
  type GitHubRepositorySyncStatus,
  type GitHubSyncStatus,
  type InboxPriority,
} from '@ecc/shared';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import {
  GitHubApiError,
  GitHubClient,
  GitHubPullRequest,
  GitHubRateLimitError,
  LOOKUP_BATCH,
} from './github.client';
import { InboxRepository, PendingReport, StoredItem, SyncStateRow } from './inbox.repository';
import { clip, InboxService, SourceEvent, SourceUpdate } from './inbox.service';

/** The first scheduled sync waits this long, so a restart loop cannot hammer GitHub. */
const STARTUP_DELAY_MS = 10_000;
/** 20 pages of 50: beyond this, the remaining open pull requests wait for the next sync. */
export const MAX_PAGES = 20;
const REPORT_LOOKUP_TIMEOUT_MS = 5_000;
/** Unconfirmed agent reports are forgotten after this. */
const PENDING_REPORT_TTL_MS = 7 * 24 * 60 * 60_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_]{20,255}$/;
const TOKEN_FILE_MAX_BYTES = 1024;
/** Shown for errors that are not GitHub's; the details go to the log only. */
const UNEXPECTED_ERROR = 'Unexpected error while syncing.';

/** Event idempotency key of an agent's pull request report. Blocker reports use their own namespace. */
export function prReportKey(idempotencyKey: string): string {
  return `agent:pull_request:${idempotencyKey}`;
}

export function pullRequestKey(repository: string, number: number): string {
  return `github:pr:${repository.toLowerCase()}#${number}`;
}

/** Draft P3; failing checks P1; otherwise, including changes requested, P2. */
export function suggestPriority(pr: GitHubPullRequest): InboxPriority {
  if (pr.draft) return 'P3';
  if (pr.checksState === 'failing') return 'P1';
  return 'P2';
}

const CHECKS_SUMMARY: Record<GitHubPullRequest['checksState'], string> = {
  passing: 'Checks are passing.',
  failing: 'Checks are failing.',
  pending: 'Checks are running.',
  none: 'No checks reported.',
  unknown: 'Checks are in an unknown state.',
};

const REVIEW_SUMMARY: Record<GitHubPullRequest['reviewState'], string> = {
  review_required: 'Review required.',
  approved: 'Approved.',
  changes_requested: 'Changes requested.',
  none: 'No review decision.',
  unknown: 'Review state unknown.',
};

interface ApplyOptions {
  allowCreate: boolean;
  report?: PendingReport & { idempotencyKey?: string };
}

type TokenResult = { token: string; problem: null } | { token: null; problem: string };

/**
 * Discovers pull requests in the allowed repositories, read-only, and keeps their items current.
 * GitHub is the source of truth for pull request state. A failed sync records its error and
 * changes nothing: items are only ever resolved by GitHub saying a pull request merged or closed.
 */
@Injectable()
export class GitHubSyncService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(GitHubSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private lastSyncAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastError: string | null = null;
  private rateLimitedUntil: Date | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly client: GitHubClient,
    private readonly inbox: InboxService,
    private readonly repository: InboxRepository,
  ) {}

  private get github() {
    return this.config.github;
  }

  onApplicationBootstrap(): void {
    if (!this.inbox.available) return;
    const states = this.repository.syncStates().filter((state) => this.isAllowed(state.repository));
    this.lastSyncAt = this.latest(states.map((state) => state.lastSyncAt));
    this.lastSuccessAt = this.latest(states.map((state) => state.lastSuccessAt));
    this.lastError = states.find((state) => state.lastError)?.lastError ?? null;
    if (this.configurationProblem() === null) this.schedule(STARTUP_DELAY_MS);
  }

  beforeApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  isAllowed(repository: string): boolean {
    return this.github.repositories.includes(repository.toLowerCase());
  }

  /** Null when GitHub sync can run. Checked without reading the token. */
  configurationProblem(): string | null {
    if (this.github.repositories.length === 0) return 'ECC_GITHUB_REPOS is not set.';
    if (!this.github.tokenFile) return 'ECC_GITHUB_TOKEN_FILE is not set.';
    return this.inspectTokenFile(this.github.tokenFile);
  }

  status(): GitHubSyncStatus {
    const problem = this.configurationProblem();
    const states = new Map(
      (this.inbox.available ? this.repository.syncStates() : []).map((state) => [state.repository, state]),
    );
    const repositories: GitHubRepositorySyncStatus[] = this.github.repositories.map((repository) => {
      const state = states.get(repository);
      return {
        repository,
        lastSyncAt: state?.lastSyncAt ?? null,
        lastSuccessAt: state?.lastSuccessAt ?? null,
        lastError: state?.lastError ?? null,
      };
    });
    return {
      configured: problem === null,
      configurationProblem: problem,
      running: this.running !== null,
      pollIntervalSeconds: this.github.pollSeconds,
      lastSyncAt: this.lastSyncAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      rateLimitedUntil: this.backoffUntil()?.toISOString() ?? null,
      repositories,
    };
  }

  /**
   * Starts a sync and returns at once. While GitHub asks to back off, nothing starts and the
   * status says until when. The sync in progress is available through `current()`.
   */
  trigger(): GitHubSyncStatus {
    const problem = this.configurationProblem();
    if (problem) throw new ApiError(400, 'GITHUB_NOT_CONFIGURED', `GitHub sync is not configured: ${problem}`);
    if (this.running) throw new ApiError(409, 'GITHUB_SYNC_RUNNING', 'A GitHub sync is already running.');
    if (!this.backoffUntil()) this.start();
    return this.status();
  }

  /** The sync in progress, for tests and for shutdown. */
  current(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /**
   * An authenticated agent says it opened this pull request. GitHub must confirm it before an
   * item exists; until then the report is kept, and the sync that first sees the PR links it.
   */
  async reportPullRequest(report: {
    repository: string;
    number: number;
    sourceSession: string | null;
    sourceAgent: string | null;
    idempotencyKey?: string;
  }): Promise<AgentReportResponse> {
    const repository = report.repository.toLowerCase();
    if (!this.isAllowed(repository)) {
      throw new ApiError(403, 'REPOSITORY_NOT_ALLOWED', `${repository} is not in ECC_GITHUB_REPOS.`);
    }
    const existing = () => this.repository.findByPullRequest(repository, report.number);
    if (report.idempotencyKey && this.inbox.hasEvent(prReportKey(report.idempotencyKey))) {
      return { itemId: existing()?.id ?? null, created: false };
    }
    const pending: PendingReport & { idempotencyKey?: string } = {
      repository,
      number: report.number,
      sourceSession: report.sourceSession,
      sourceAgent: report.sourceAgent,
      reportedAt: new Date().toISOString(),
      idempotencyKey: report.idempotencyKey,
    };

    const pr = await this.lookupForReport(repository, report.number);
    if (pr) {
      const result = this.applyPullRequest(pr, { allowCreate: true, report: pending });
      if (result) return { itemId: result.item.id, created: result.created };
    }
    const item = existing();
    if (item) {
      const result = this.inbox.applySource(item.sourceKey, (current) =>
        current ? this.attribute(current, pending) : null,
      );
      return { itemId: result?.item.id ?? item.id, created: false };
    }
    this.repository.savePendingReport(pending);
    return { itemId: null, created: false };
  }

  /**
   * Applies what GitHub says about one pull request. Only a reopened PR, or checks that start
   * failing, count as a new actionable condition. A merged or closed PR resolves its item.
   */
  applyPullRequest(pr: GitHubPullRequest, options: ApplyOptions) {
    return this.inbox.applySource(pullRequestKey(pr.repository, pr.number), (current) => {
      if (!current && !options.allowCreate) return null;
      const now = new Date().toISOString();
      const events: SourceEvent[] = [];
      const event = (kind: string, summary: string, occurredAt = now) =>
        events.push({ kind, source: 'github', summary, occurredAt });
      const before = current?.pullRequest ?? null;

      if (!before) {
        const by = pr.author ? ` by ${pr.author}` : '';
        event('pr.discovered', `Pull request #${pr.number} discovered${by}${pr.draft ? ' (draft)' : ''}.`, pr.createdAt);
      } else {
        if (before.draft !== pr.draft) {
          event(pr.draft ? 'pr.converted_to_draft' : 'pr.ready_for_review', pr.draft ? 'Converted to draft.' : 'Ready for review.');
        }
        if (before.checksState !== pr.checksState) event(`pr.checks_${pr.checksState}`, CHECKS_SUMMARY[pr.checksState]);
        if (before.reviewState !== pr.reviewState) event('pr.review_changed', REVIEW_SUMMARY[pr.reviewState]);
        if (current && current.title !== clip(pr.title.trim(), INBOX_LIMITS.titleMax)) {
          event('pr.title_changed', 'Title changed.');
        }
      }
      const reopened = current?.sourceState === 'closed' && pr.state === 'open';
      if (current && current.sourceState !== pr.state) {
        if (pr.state === 'merged') event('pr.merged', 'Merged on GitHub.');
        else if (pr.state === 'closed') event('pr.closed', 'Closed on GitHub without merging.');
        else if (reopened) event('pr.reopened', 'Reopened on GitHub.');
      }
      const startedFailing =
        before !== null && pr.state === 'open' && pr.checksState === 'failing' && before.checksState !== 'failing';

      const update: SourceUpdate = {
        create: { type: 'pull_request', source: 'github' },
        title: pr.title,
        suggestedPriority: suggestPriority(pr),
        sourceState: pr.state,
        pullRequest: {
          repository: pr.repository,
          number: pr.number,
          url: pr.url,
          author: pr.author,
          draft: pr.draft,
          reviewState: pr.reviewState,
          checksState: pr.checksState,
          attribution: before?.attribution ?? 'discovered',
        },
        reopen: reopened || startedFailing,
        resolve: pr.state === 'merged' ? 'auto_merged' : pr.state === 'closed' ? 'auto_closed' : undefined,
        events,
      };
      return options.report ? this.withAttribution(update, current, options.report) : update;
    });
  }

  private attribute(current: StoredItem, report: PendingReport & { idempotencyKey?: string }): SourceUpdate {
    return this.withAttribution({ events: [] }, current, report);
  }

  /** Links the reporting agent's session. Attribution is never inferred from the author. */
  private withAttribution(
    update: SourceUpdate,
    current: StoredItem | null,
    report: PendingReport & { idempotencyKey?: string },
  ): SourceUpdate {
    const where = report.sourceSession ? ` in session ${report.sourceSession}` : ' from an unknown session';
    return {
      ...update,
      sourceSession: report.sourceSession ?? current?.sourceSession ?? null,
      sourceAgent: report.sourceAgent ?? current?.sourceAgent ?? null,
      pullRequest: { ...(update.pullRequest ?? current?.pullRequest ?? {}), attribution: 'agent_reported' },
      events: [
        ...update.events,
        {
          kind: 'pr.reported_by_agent',
          source: 'claude',
          summary: `Reported by an agent${where}.`,
          occurredAt: report.reportedAt,
          idempotencyKey: report.idempotencyKey ? prReportKey(report.idempotencyKey) : undefined,
        },
      ],
    };
  }

  private async lookupForReport(repository: string, number: number): Promise<GitHubPullRequest | null> {
    const token = this.readToken();
    if (!token.token || this.backoffUntil()) return null;
    try {
      const found = await this.withTimeout(
        this.client.pullRequests(token.token, repository, [number]),
        REPORT_LOOKUP_TIMEOUT_MS,
      );
      return found.get(number) ?? null;
    } catch (error) {
      this.noteRateLimit(error);
      return null;
    }
  }

  private start(): void {
    this.running = this.syncAll()
      .catch((error: Error) => this.logger.warn(`GitHub sync failed: ${error.message}`))
      .finally(() => {
        this.running = null;
        this.inbox.publish({ type: 'inbox.sync.completed', data: this.status() });
      });
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      if (!this.running && !this.backoffUntil() && this.configurationProblem() === null) this.start();
      void this.current().then(() => this.schedule(this.github.pollSeconds * 1000));
    }, delayMs);
    this.timer.unref();
  }

  private async syncAll(): Promise<void> {
    const token = this.readToken();
    const finishedAt = () => new Date().toISOString();
    if (!token.token) {
      this.lastError = token.problem;
      this.lastSyncAt = finishedAt();
      return;
    }
    let firstError: string | null = null;
    for (const repository of this.github.repositories) {
      if (this.stopped) return;
      try {
        await this.syncRepository(token.token, repository);
      } catch (error) {
        const message = this.describe(error);
        if (message === UNEXPECTED_ERROR) {
          this.logger.warn(`GitHub sync of ${repository} failed: ${(error as Error)?.message ?? String(error)}`);
        }
        firstError ??= `${repository}: ${message}`;
        this.saveState(repository, { lastSyncAt: finishedAt(), lastError: message });
        if (error instanceof GitHubRateLimitError) break;
      }
      if (this.noteExhausted()) {
        firstError ??= `GitHub rate limit reached. Retrying after ${this.backoffUntil()?.toISOString()}.`;
        break;
      }
    }
    this.lastSyncAt = finishedAt();
    this.lastError = firstError;
    if (!firstError) this.lastSuccessAt = this.lastSyncAt;
  }

  private async syncRepository(token: string, repository: string): Promise<void> {
    const state = this.stateOf(repository);
    const open: GitHubPullRequest[] = [];
    let cursor: string | null = null;
    let truncated = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await this.client.openPullRequests(token, repository, cursor);
      open.push(...result.pullRequests);
      cursor = result.endCursor;
      if (!result.hasNextPage) break;
      truncated = page === MAX_PAGES - 1;
    }

    const now = new Date().toISOString();
    const baselineAt = state.baselineAt ?? now;
    const reports = new Map(this.repository.pendingReports(repository).map((report) => [report.number, report]));
    const seen = new Set<number>();
    this.inbox.run(() => {
      for (const pr of open) {
        seen.add(pr.number);
        const report = reports.get(pr.number);
        this.applyPullRequest(pr, { allowCreate: report !== undefined || this.mayCreate(pr, state, baselineAt), report });
        if (report) this.repository.deletePendingReport(repository, pr.number);
      }
    });

    // Tracked PRs that left the open list merged or closed. Only these are looked up: closed pull
    // requests are never listed wholesale. Truncated listings fall back to the same lookups.
    const missing = this.repository
      .openPullRequests(repository)
      .map((item) => item.pullRequest?.number as number)
      .filter((number) => !seen.has(number));
    const unconfirmed = [...reports.keys()].filter((number) => !seen.has(number));
    const lookups = [...new Set([...missing, ...unconfirmed])];
    for (let index = 0; index < lookups.length; index += LOOKUP_BATCH) {
      const batch = lookups.slice(index, index + LOOKUP_BATCH);
      const found = await this.client.pullRequests(token, repository, batch);
      this.inbox.run(() => {
        for (const pr of found.values()) {
          const report = reports.get(pr.number);
          this.applyPullRequest(pr, { allowCreate: report !== undefined, report });
          if (report) this.repository.deletePendingReport(repository, pr.number);
        }
        for (const number of batch.filter((n) => !found.has(n))) this.notFound(repository, number, reports.get(number));
      });
    }
    this.repository.deletePendingReportsBefore(new Date(Date.now() - PENDING_REPORT_TTL_MS).toISOString());

    this.saveState(repository, {
      lastSyncAt: now,
      lastSuccessAt: now,
      lastError: truncated ? `Only the newest ${MAX_PAGES * 50} open pull requests were read.` : null,
      initialSyncDone: true,
      baselineAt,
    });
  }

  /**
   * Which open pull requests become items. `open` imports every one, as do later syncs. `new`
   * imports none on the first sync, and afterwards only those created after it, plus whatever
   * an agent reports.
   */
  private mayCreate(pr: GitHubPullRequest, state: SyncStateRow, baselineAt: string): boolean {
    const author = pr.author?.toLowerCase() ?? '';
    if (this.github.authors.length > 0 && !this.github.authors.includes(author)) return false;
    if (this.github.initialSync === 'open') return true;
    return state.initialSyncDone && pr.createdAt >= baselineAt;
  }

  /**
   * GitHub has no pull request with this number: a wrong report, an issue number, or a deleted or
   * transferred PR. A report of it is dropped. A tracked item keeps its state, because absence is
   * not a merge or a close, and its history says so once.
   */
  private notFound(repository: string, number: number, report: PendingReport | undefined): void {
    const now = new Date().toISOString();
    if (report) {
      this.repository.deletePendingReport(repository, number);
      this.repository.insertEvent(
        randomUUID(),
        {
          itemId: null,
          kind: 'pr.report_dropped',
          source: 'system',
          summary: `An agent reported ${repository}#${number}, which GitHub does not have. The report was dropped.`,
          occurredAt: now,
        },
        now,
      );
    }
    this.inbox.applySource(pullRequestKey(repository, number), (current) =>
      current
        ? {
            events: [
              {
                kind: 'pr.not_found',
                source: 'system',
                summary: 'GitHub no longer finds this pull request. Its state is kept; resolve it if it is gone.',
                occurredAt: now,
                idempotencyKey: `github:not_found:${repository}#${number}`,
              },
            ],
          }
        : null,
    );
  }

  private stateOf(repository: string): SyncStateRow {
    return (
      this.repository.syncStates().find((state) => state.repository === repository) ?? {
        repository,
        lastSyncAt: null,
        lastSuccessAt: null,
        lastError: null,
        initialSyncDone: false,
        baselineAt: null,
      }
    );
  }

  private saveState(repository: string, changes: Partial<SyncStateRow>): void {
    if (!this.inbox.available) return;
    this.repository.saveSyncState({ ...this.stateOf(repository), ...changes, repository });
  }

  private backoffUntil(): Date | null {
    if (this.rateLimitedUntil && this.rateLimitedUntil.getTime() <= Date.now()) this.rateLimitedUntil = null;
    return this.rateLimitedUntil;
  }

  private noteRateLimit(error: unknown): void {
    if (error instanceof GitHubRateLimitError) this.rateLimitedUntil = error.until;
  }

  private noteExhausted(): boolean {
    const until = this.client.exhaustedUntil;
    this.client.exhaustedUntil = null;
    if (until && until.getTime() > Date.now()) this.rateLimitedUntil = until;
    return this.backoffUntil() !== null;
  }

  private describe(error: unknown): string {
    this.noteRateLimit(error);
    if (error instanceof GitHubRateLimitError || error instanceof GitHubApiError) return error.message;
    return UNEXPECTED_ERROR;
  }

  /**
   * The token file must hold only the token, belong to this user, and be unreadable by others.
   * A symlink is refused, because its target's permissions are not the file's.
   */
  private inspectTokenFile(path: string): string | null {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return 'ECC_GITHUB_TOKEN_FILE must not be a symlink.';
      if (!stat.isFile()) return 'ECC_GITHUB_TOKEN_FILE is not a regular file.';
      if (process.getuid && stat.uid !== process.getuid()) {
        return 'ECC_GITHUB_TOKEN_FILE must belong to the user running the dashboard.';
      }
      if ((stat.mode & 0o077) !== 0) {
        return 'ECC_GITHUB_TOKEN_FILE is readable by other users. Run chmod 600 on it.';
      }
      if (stat.size > TOKEN_FILE_MAX_BYTES) return 'ECC_GITHUB_TOKEN_FILE is too large to be a token.';
      return null;
    } catch {
      return 'ECC_GITHUB_TOKEN_FILE cannot be read.';
    }
  }

  private readToken(): TokenResult {
    const problem = this.configurationProblem();
    if (problem) return { token: null, problem };
    try {
      const token = readFileSync(this.github.tokenFile as string, 'utf8').trim();
      return TOKEN_PATTERN.test(token)
        ? { token, problem: null }
        : { token: null, problem: 'ECC_GITHUB_TOKEN_FILE does not contain a token.' };
    } catch {
      return { token: null, problem: 'ECC_GITHUB_TOKEN_FILE cannot be read.' };
    }
  }

  private latest(values: (string | null)[]): string | null {
    return values.reduce<string | null>((a, b) => (b && (!a || b > a) ? b : a), null);
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GitHubApiError('GitHub did not answer in time.')), ms);
      timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
