import type { GitHubSyncStatus, InboxSummary } from '@ecc/shared';
import { formatAge } from '../../services/format';

interface InboxSummaryStripProps {
  summary: InboxSummary | null;
  summaryError: string | null;
  syncing: boolean;
  syncError: string | null;
  onSync: () => void;
}

/** One line about GitHub synchronization health, and whether it is a problem. */
function syncHealth(github: GitHubSyncStatus): { text: string; problem: boolean } {
  if (!github.configured) {
    const reason = github.configurationProblem ? `: ${github.configurationProblem}` : '.';
    return { text: `GitHub sync is not configured${reason}`, problem: false };
  }
  if (github.rateLimitedUntil) {
    const until = new Date(github.rateLimitedUntil).toLocaleTimeString();
    return { text: `GitHub rate limit reached. Paused until ${until}.`, problem: true };
  }
  if (github.lastError) return { text: `Last GitHub sync failed: ${github.lastError}`, problem: true };
  if (github.running) return { text: 'Syncing with GitHub…', problem: false };
  if (github.lastSuccessAt) return { text: `Synced with GitHub ${formatAge(github.lastSuccessAt)}.`, problem: false };
  return { text: 'Not synced with GitHub yet.', problem: false };
}

function Count({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-base font-semibold tabular-nums">{value ?? '–'}</span>
      <span className="text-xs text-muted">{label}</span>
    </div>
  );
}

export function InboxSummaryStrip(props: InboxSummaryStripProps) {
  const { summary } = props;
  const github = summary?.github;
  const health = github ? syncHealth(github) : null;
  // A single repository's error usually repeats the global one, which is already shown.
  const failingRepositories =
    github?.repositories.filter((repository) => repository.lastError && repository.lastError !== github.lastError) ??
    [];
  const isSyncDisabled = props.syncing || !github?.configured || github.running;
  const isReportingUnavailable = summary?.agentReportingAvailable === false;

  return (
    <section aria-label="Inbox summary" className="flex flex-col gap-2 border-b border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <Count label="open" value={summary?.open} />
        <Count label="need attention" value={summary?.needsAttention} />
        <Count label="PRs awaiting review" value={summary?.pullRequestsAwaitingReview} />
        <button
          type="button"
          onClick={props.onSync}
          disabled={isSyncDisabled}
          className="rounded border border-line px-2 py-0.5 text-xs whitespace-nowrap hover:border-accent hover:text-accent disabled:opacity-50 disabled:hover:border-line disabled:hover:text-ink"
        >
          {props.syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      {health && (
        <p role="status" className={`text-xs ${health.problem ? 'text-red-300' : 'text-muted'}`}>
          {health.text}
        </p>
      )}
      {failingRepositories.length > 0 && (
        <ul className="text-xs text-red-300">
          {failingRepositories.map((repository) => (
            <li key={repository.repository} className="break-words">
              {repository.repository}: {repository.lastError}
            </li>
          ))}
        </ul>
      )}
      {props.syncError && (
        <p role="alert" className="text-xs text-red-300">
          {props.syncError}
        </p>
      )}
      {props.summaryError && (
        <p role="alert" className="text-xs text-red-300">
          Summary unavailable: {props.summaryError}
        </p>
      )}
      {isReportingUnavailable && (
        <p className="text-xs text-muted">
          Agent reporting is unavailable: the server could not prepare its hook credentials.
        </p>
      )}
    </section>
  );
}
