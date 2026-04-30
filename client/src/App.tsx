import { useState, useEffect } from 'preact/hooks';
import Router from 'preact-router';
import { ProjectList } from './components/ProjectList';
import { ProjectDetail } from './components/ProjectDetail';
import { AnalyticsView } from './components/AnalyticsView';
import { OfflineScreen } from './components/OfflineScreen';

export function App() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    // Ping the server once on startup. A network error (server unreachable)
    // throws; any HTTP response (including 401) means the server is up.
    fetch('/api/projects', { signal: AbortSignal.timeout(2000) })
      .catch(() => setOffline(true));
  }, []);

  if (offline) return <OfflineScreen onOnline={() => setOffline(false)} />;

  return (
    <div class="app">
      <Router>
        <ProjectList path="/" onPreviewOffline={() => setOffline(true)} />
        <ProjectDetail path="/projects/:id" />
        <AnalyticsView path="/analytics" />
      </Router>
    </div>
  );
}
