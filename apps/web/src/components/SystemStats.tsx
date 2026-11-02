import type { SystemStatsState } from '../hooks/useSystemStats';
import { formatBytes } from '../services/format';

function Meter({ label, percent, detail }: { label: string; percent: number; detail: string }) {
  const color = percent >= 90 ? 'bg-red-400' : percent >= 70 ? 'bg-yellow-400' : 'bg-accent';
  return (
    <div className="flex items-center gap-2 text-xs" title={detail}>
      <span className="text-muted">{label}</span>
      <span
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-overlay lg:block"
      >
        <span
          className={`block h-full rounded-full ${color}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </span>
      <span className="font-mono tabular-nums">{Math.round(percent)}%</span>
    </div>
  );
}

export function SystemStats({ system }: { system: SystemStatsState }) {
  const { data: stats, error, loading } = system;
  const online = !error && !loading;
  const usedDisk = stats ? stats.disk.totalBytes - stats.disk.availableBytes : 0;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line px-4 py-1.5">
      <span className="flex items-center gap-1.5 text-xs">
        <span
          aria-hidden
          className={`h-2 w-2 rounded-full ${online ? 'bg-green-400' : error ? 'bg-red-400' : 'bg-yellow-400'}`}
        />
        <span className="text-muted">
          {error ? 'Server unreachable' : loading ? 'Connecting' : 'Server online'}
        </span>
      </span>
      {stats && (
        <>
          <Meter label="CPU" percent={stats.cpuPercent} detail={`${stats.cpuPercent}% utilization`} />
          <Meter
            label="RAM"
            percent={(stats.memory.usedBytes / stats.memory.totalBytes) * 100}
            detail={`${formatBytes(stats.memory.usedBytes)} of ${formatBytes(stats.memory.totalBytes)}`}
          />
          <Meter
            label="Disk"
            percent={(usedDisk / stats.disk.totalBytes) * 100}
            detail={`${formatBytes(stats.disk.availableBytes)} free of ${formatBytes(stats.disk.totalBytes)}`}
          />
        </>
      )}
    </div>
  );
}
