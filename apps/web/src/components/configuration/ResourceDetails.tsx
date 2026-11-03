import { useCallback } from 'react';
import type { ClaudeMetadataValue, ClaudeResourceSummary } from '@ecc/shared';
import { useLoad } from '../../hooks/useLoad';
import { api } from '../../services/api';
import { MarkdownViewer } from './MarkdownViewer';
import { OriginBadge } from './OriginBadge';
import { EmptyMessage, ErrorMessage, LoadingMessage } from './states';

function formatValue(value: ClaudeMetadataValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

function Field({ label, value }: { label: string; value: ClaudeMetadataValue }) {
  return (
    <div className="contents">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{formatValue(value)}</dd>
    </div>
  );
}

const UNAVAILABLE = {
  'too-large': 'This file is over the 1 MiB display limit.',
  unreadable: 'The server is not permitted to read this file.',
  unsafe: 'This file was refused, because it is not a regular text file at its expected path.',
};

export function ResourceDetails({
  resource,
  refreshKey,
}: {
  resource: ClaudeResourceSummary;
  refreshKey: number;
}) {
  const { id, unavailable } = resource;
  const load = useCallback(() => api.getClaudeResource(id), [id]);
  const { data, loading, error } = useLoad(unavailable ? null : load, refreshKey);
  const detail = data?.id === id ? data : null;
  const shown = detail ?? resource;

  return (
    <article aria-label={`${shown.name} details`} className="p-4">
      <header className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold break-all">{shown.name}</h3>
          <OriginBadge origin={shown.origin} />
        </div>
        <p className="mt-1 font-mono text-xs break-all text-muted">{shown.relativePath}</p>
        {shown.description && <p className="mt-2 text-[13px]">{shown.description}</p>}
      </header>
      <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        {shown.model && <Field label="Model" value={shown.model} />}
        {shown.tools && <Field label="Tools" value={shown.tools} />}
        {shown.disallowedTools && <Field label="Disallowed tools" value={shown.disallowedTools} />}
        {Object.entries(shown.metadata ?? {}).map(([key, value]) => (
          <Field key={key} label={key} value={value} />
        ))}
        {detail?.modifiedAt && (
          <Field label="Modified" value={new Date(detail.modifiedAt).toLocaleString()} />
        )}
      </dl>
      {shown.frontmatter === 'invalid' && (
        <p className="mb-3 rounded bg-amber-950/50 px-2 py-1 text-xs text-amber-300">
          This file's frontmatter could not be parsed, so its metadata is not shown.
        </p>
      )}
      {unavailable && <ErrorMessage>{UNAVAILABLE[unavailable]}</ErrorMessage>}
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {loading && !detail && <LoadingMessage>Loading content…</LoadingMessage>}
      {detail &&
        (detail.body.trim() ? (
          <MarkdownViewer source={detail.body} />
        ) : (
          <EmptyMessage>This file has no content to show.</EmptyMessage>
        ))}
    </article>
  );
}
