import { useCallback, useState } from 'react';
import { isValidSessionName, type CreateSessionRequest } from '@ecc/shared';
import { AppLayout } from './components/AppLayout';
import { CreateSessionDialog } from './components/CreateSessionDialog';
import { Sidebar, type View } from './components/Sidebar';
import { TerminateSessionDialog } from './components/TerminateSessionDialog';
import { useClaudeStatus } from './hooks/useClaudeStatus';
import { useSessions } from './hooks/useSessions';
import { useSystemStats } from './hooks/useSystemStats';
import { DashboardPage } from './pages/DashboardPage';
import { ConfigurationPage } from './pages/ConfigurationPage';
import { ServerPage } from './pages/ServerPage';

function sessionFromHash(): string | null {
  const name = decodeURIComponent(window.location.hash.replace(/^#\/?/, ''));
  return isValidSessionName(name) ? name : null;
}

export function App() {
  const sessions = useSessions();
  const system = useSystemStats();
  const monitor = useClaudeStatus();
  const [view, setView] = useState<View>('sessions');
  const [selected, setSelected] = useState<string | null>(sessionFromHash);
  const [creating, setCreating] = useState(false);
  const [terminating, setTerminating] = useState<string | null>(null);

  const select = useCallback((name: string | null) => {
    setSelected(name);
    setView('sessions');
    // replaceState, so that switching terminals does not fill the browser history.
    window.history.replaceState(null, '', name ? `#/${encodeURIComponent(name)}` : '#/');
  }, []);

  const createSession = async (request: CreateSessionRequest) => {
    const created = await sessions.createSession(request);
    setCreating(false);
    select(created.name);
  };

  const terminateSession = async (name: string) => {
    await sessions.terminateSession(name);
    setTerminating(null);
    if (selected === name) select(null);
  };

  return (
    <AppLayout
      system={system}
      sidebar={
        <Sidebar
          sessions={sessions.sessions}
          loading={sessions.loading}
          error={sessions.error}
          selected={selected}
          view={view}
          monitor={monitor}
          onSelect={select}
          onCreate={() => setCreating(true)}
          onNavigate={setView}
        />
      }
    >
      {view === 'server' ? (
        <ServerPage system={system} />
      ) : view === 'configuration' ? (
        <ConfigurationPage />
      ) : (
        <DashboardPage
          selected={selected}
          sessions={sessions.sessions}
          monitor={monitor}
          onCreate={() => setCreating(true)}
          onTerminate={setTerminating}
          onSessionEnded={sessions.refresh}
        />
      )}
      {creating && (
        <CreateSessionDialog onCreate={createSession} onClose={() => setCreating(false)} />
      )}
      {terminating && (
        <TerminateSessionDialog
          session={terminating}
          onConfirm={() => terminateSession(terminating)}
          onClose={() => setTerminating(null)}
        />
      )}
    </AppLayout>
  );
}
