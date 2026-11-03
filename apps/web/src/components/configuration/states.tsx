import type { ReactNode } from 'react';

export function LoadingMessage({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="p-4 text-xs text-muted">
      {children}
    </p>
  );
}

export function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="m-4 rounded bg-red-950/60 px-2 py-1 text-xs text-red-300">
      {children}
    </p>
  );
}

export function EmptyMessage({ children }: { children: ReactNode }) {
  return <p className="p-4 text-xs text-muted">{children}</p>;
}
