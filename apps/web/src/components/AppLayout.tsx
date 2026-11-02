import type { ReactNode } from 'react';
import type { SystemStatsState } from '../hooks/useSystemStats';
import { SystemStats } from './SystemStats';

interface AppLayoutProps {
  sidebar: ReactNode;
  system: SystemStatsState;
  children: ReactNode;
}

export function AppLayout({ sidebar, system, children }: AppLayoutProps) {
  return (
    <div className="flex h-full flex-col md:flex-row">
      {sidebar}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SystemStats system={system} />
        <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>
    </div>
  );
}
