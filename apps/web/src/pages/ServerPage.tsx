import type { SystemStatsState } from '../hooks/useSystemStats';
import { formatBytes, formatUptime } from '../services/format';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line py-2 text-[13px] last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}

export function ServerPage({ system }: { system: SystemStatsState }) {
  const { data: stats, error, loading } = system;
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <h2 className="mb-4 text-sm font-semibold">Server</h2>
      {error && (
        <p role="alert" className="mb-4 rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">
          {error}
        </p>
      )}
      {loading && !stats && <p className="text-xs text-muted">Loading server statistics…</p>}
      {stats && (
        <dl className="max-w-lg rounded-lg border border-line bg-raised px-4 py-1">
          <Row label="CPU utilization" value={`${stats.cpuPercent}%`} />
          <Row label="Total RAM" value={formatBytes(stats.memory.totalBytes)} />
          <Row label="Used RAM" value={formatBytes(stats.memory.usedBytes)} />
          <Row label="Available RAM" value={formatBytes(stats.memory.availableBytes)} />
          <Row label={`Total disk (${stats.disk.path})`} value={formatBytes(stats.disk.totalBytes)} />
          <Row
            label={`Available disk (${stats.disk.path})`}
            value={formatBytes(stats.disk.availableBytes)}
          />
          <Row label="Uptime" value={formatUptime(stats.uptimeSeconds)} />
        </dl>
      )}
    </div>
  );
}
