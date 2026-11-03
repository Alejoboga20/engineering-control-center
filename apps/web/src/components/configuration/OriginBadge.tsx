import type { ClaudeConfigOrigin } from '@ecc/shared';

const STYLES: Record<ClaudeConfigOrigin, { label: string; className: string }> = {
  global: { label: 'Global', className: 'border-sky-800 text-sky-300' },
  project: { label: 'Project', className: 'border-emerald-800 text-emerald-300' },
  local: { label: 'Local', className: 'border-amber-800 text-amber-300' },
};

export function OriginBadge({ origin }: { origin: ClaudeConfigOrigin }) {
  const { label, className } = STYLES[origin];
  return (
    <span className={`rounded border px-1 py-px text-[10px] leading-4 whitespace-nowrap ${className}`}>
      {label}
    </span>
  );
}
