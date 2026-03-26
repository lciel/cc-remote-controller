import { useState, useEffect } from 'preact/hooks';
import { useProjects } from '../hooks/useProjects';
import { ProjectCard } from './ProjectCard';
import { api, setToken, DiscoveredProject } from '../api/rest';
import { reconnectWs, useGlobalWsMessage } from '../hooks/useWebSocket';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { BottomSheet } from './BottomSheet';
import { WOL_URL_KEY } from './OfflineScreen';

export const SLEEP_CMD_KEY = 'cc-sleep-cmd';

interface Props {
  path?: string;
  onPreviewOffline?: () => void;
}

export function ProjectList({ onPreviewOffline }: Props) {
  const { projects, loading, error, refresh } = useProjects();
  usePageVisibility(refresh);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tokenInput, setTokenInput] = useState(
    sessionStorage.getItem('cc-auth-token') || ''
  );
  const [wolUrlInput, setWolUrlInput] = useState(
    localStorage.getItem(WOL_URL_KEY) || ''
  );
  const [sleepCmdInput, setSleepCmdInput] = useState(
    localStorage.getItem(SLEEP_CMD_KEY) || ''
  );
  const [showSleepConfirm, setShowSleepConfirm] = useState(false);
  const [sleeping, setSleeping] = useState(false);

  // Fetch settings from server on mount
  useEffect(() => {
    api.getSettings().then(s => {
      if (s.wolUrl) { localStorage.setItem(WOL_URL_KEY, s.wolUrl); setWolUrlInput(s.wolUrl); }
      if (s.sleepCmd) { localStorage.setItem(SLEEP_CMD_KEY, s.sleepCmd); setSleepCmdInput(s.sleepCmd); }
    }).catch(() => { /* use localStorage fallback */ });
  }, []);

  // Receive settings updates from other clients
  useGlobalWsMessage((data: unknown) => {
    const msg = data as { type?: string; wolUrl?: string; sleepCmd?: string };
    if (msg.type === 'settings_update') {
      if (msg.wolUrl !== undefined) { localStorage.setItem(WOL_URL_KEY, msg.wolUrl); setWolUrlInput(msg.wolUrl); }
      if (msg.sleepCmd !== undefined) { localStorage.setItem(SLEEP_CMD_KEY, msg.sleepCmd); setSleepCmdInput(msg.sleepCmd); }
    }
  });

  // Discovery state
  const [discovered, setDiscovered] = useState<DiscoveredProject[]>([]);
  const [loadingDiscover, setLoadingDiscover] = useState(false);
  const [inputMode, setInputMode] = useState<'select' | 'manual'>('select');

  useEffect(() => {
    if (showCreate) {
      setLoadingDiscover(true);
      api.discoverProjects().then((projects) => {
        setDiscovered(projects);
        if (projects.length === 0) setInputMode('manual');
      }).catch(() => {
        setInputMode('manual');
      }).finally(() => {
        setLoadingDiscover(false);
      });
    } else {
      setDiscovered([]);
      setInputMode('select');
    }
  }, [showCreate]);

  const handleCreate = async () => {
    if (!name || !repoPath) return;
    setCreating(true);
    try {
      await api.createProject(name, repoPath);
      setName('');
      setRepoPath('');
      setShowCreate(false);
      refresh();
    } catch {
      alert('Failed to create project');
    } finally {
      setCreating(false);
    }
  };

  const handleSelectProject = (dp: DiscoveredProject) => {
    setName(dp.name);
    setRepoPath(dp.path);
    setInputMode('manual');
  };

  const handleSaveToken = () => {
    setToken(tokenInput);
    localStorage.setItem(WOL_URL_KEY, wolUrlInput.trim());
    localStorage.setItem(SLEEP_CMD_KEY, sleepCmdInput.trim());
    api.updateSettings({ wolUrl: wolUrlInput.trim(), sleepCmd: sleepCmdInput.trim() }).catch(() => { /* ignore */ });
    reconnectWs();
    setShowSettings(false);
    refresh();
  };

  const handleSleep = async () => {
    const cmd = localStorage.getItem(SLEEP_CMD_KEY) || '';
    if (!cmd) return;
    setSleeping(true);
    try {
      await api.sleepSystem(cmd);
    } catch { /* server may go down before responding */ }
    setSleeping(false);
    setShowSleepConfirm(false);
  };

  const handleCloseCreate = () => {
    setShowCreate(false);
    setName('');
    setRepoPath('');
    setInputMode('select');
  };

  return (
    <div class="page">
      <header class="header">
        <h1>
          <svg viewBox="0 0 20 14" width="26" height="18" shape-rendering="crispEdges" style={{ verticalAlign: '-2px', marginRight: '9px' }}>
            <rect x="0" y="4" width="3" height="4" fill="#c07a50" />
            <rect x="17" y="4" width="3" height="4" fill="#c07a50" />
            <rect x="3" y="0" width="14" height="11" fill="#c07a50" />
            <rect x="6" y="4" width="2" height="3" fill="#2c1810" />
            <rect x="13" y="4" width="2" height="3" fill="#2c1810" />
            <rect x="5" y="11" width="2" height="3" fill="#c07a50" />
            <rect x="8" y="11" width="2" height="3" fill="#c07a50" />
            <rect x="11" y="11" width="2" height="3" fill="#c07a50" />
            <rect x="14" y="11" width="2" height="3" fill="#c07a50" />
          </svg>
          ccctl
        </h1>
        <div class="header-actions">
          {localStorage.getItem(SLEEP_CMD_KEY) && (
            <button class="btn-icon header-circle-btn sleep-btn" onClick={() => setShowSleepConfirm(true)} aria-label="Sleep PC">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" />
                <line x1="12" y1="2" x2="12" y2="12" />
              </svg>
            </button>
          )}
          <button class="btn-icon header-circle-btn" onClick={() => { setShowSettings(!showSettings); setShowCreate(false); }} aria-label="Settings">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      </header>

      {showSleepConfirm && (
        <BottomSheet title="Sleep PC" onClose={() => setShowSleepConfirm(false)}>
          <div style={{ padding: '0 16px' }}>
            <p style={{ margin: '0 0 16px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
              Run the sleep command on the server?
            </p>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                class="btn btn-danger"
                style={{ flex: 1 }}
                disabled={sleeping}
                onClick={handleSleep}
              >
                {sleeping ? 'Running...' : 'Run'}
              </button>
              <button class="btn" style={{ flex: 1 }} onClick={() => setShowSleepConfirm(false)}>
                Cancel
              </button>
            </div>
          </div>
        </BottomSheet>
      )}

      {showSettings && (
        <BottomSheet title="Settings" onClose={() => setShowSettings(false)}>
          <div style={{ padding: '0 16px' }}>
            <label class="label">Auth Token</label>
            <input
              type="password"
              class="input"
              value={tokenInput}
              onInput={(e) => setTokenInput((e.target as HTMLInputElement).value)}
            />
            <label class="label" style={{ marginTop: '16px' }}>Wake-on-LAN URL</label>
            <input
              type="url"
              class="input"
              value={wolUrlInput}
              placeholder="http://192.168.0.x:9009/wake"
              onInput={(e) => setWolUrlInput((e.target as HTMLInputElement).value)}
            />
            <p class="settings-hint">POST endpoint called when the server is unreachable.</p>
            <label class="label" style={{ marginTop: '16px' }}>Sleep Command</label>
            <input
              type="text"
              class="input"
              value={sleepCmdInput}
              placeholder="powershell.exe -c Start-Sleep..."
              onInput={(e) => setSleepCmdInput((e.target as HTMLInputElement).value)}
            />
            <p class="settings-hint">Shell command executed on the server. Power icon appears in header when set.</p>
            <button class="btn btn-primary" style={{ width: '100%', marginTop: '12px' }} onClick={handleSaveToken}>
              Save
            </button>
            {onPreviewOffline && (
              <button class="btn" style={{ width: '100%', marginTop: '8px' }} onClick={() => { setShowSettings(false); onPreviewOffline(); }}>
                Preview Offline Screen
              </button>
            )}
          </div>
        </BottomSheet>
      )}

      {loading && (
        <div class="loading-splash">
          <svg viewBox="0 0 20 14" width="120" height="84" shape-rendering="crispEdges">
            <rect x="0" y="4" width="3" height="4" fill="#c07a50" />
            <rect x="17" y="4" width="3" height="4" fill="#c07a50" />
            <rect x="3" y="0" width="14" height="11" fill="#c07a50" />
            <rect x="6" y="4" width="2" height="3" fill="#2c1810" />
            <rect x="13" y="4" width="2" height="3" fill="#2c1810" />
            <rect x="5" y="11" width="2" height="3" fill="#c07a50" />
            <rect x="8" y="11" width="2" height="3" fill="#c07a50" />
            <rect x="11" y="11" width="2" height="3" fill="#c07a50" />
            <rect x="14" y="11" width="2" height="3" fill="#c07a50" />
          </svg>
        </div>
      )}
      {error && <div class="error">{error}</div>}

      <div class="project-list">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} />
        ))}
        {!loading && projects.length === 0 && (
          <div class="empty">No projects yet. Add one to get started.</div>
        )}
        {!showSettings && (
          <>
            {showCreate ? (
              <div class="card" style={{ marginTop: '4px' }}>
                {/* Tab buttons */}
                {discovered.length > 0 && (
                  <div class="discover-tabs">
                    <button
                      class={`btn btn-sm ${inputMode === 'select' ? 'btn-tab-active' : ''}`}
                      onClick={() => setInputMode('select')}
                    >
                      Select
                    </button>
                    <button
                      class={`btn btn-sm ${inputMode === 'manual' ? 'btn-tab-active' : ''}`}
                      onClick={() => setInputMode('manual')}
                    >
                      Manual
                    </button>
                  </div>
                )}

                {inputMode === 'select' ? (
                  // Discovery list
                  <div>
                    {loadingDiscover ? (
                      <div class="loading">Searching...</div>
                    ) : discovered.length === 0 ? (
                      <div class="empty" style={{ padding: '12px 0' }}>No Claude Code projects found.</div>
                    ) : (
                      <div class="discover-list">
                        {discovered.map((dp) => (
                          <button
                            key={dp.path}
                            class="discover-item"
                            onClick={() => handleSelectProject(dp)}
                          >
                            <div class="discover-item-name">{dp.name}</div>
                            <div class="discover-item-path">{dp.path}</div>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      class="btn"
                      style={{ width: '100%', marginTop: '8px' }}
                      onClick={handleCloseCreate}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  // Manual input form
                  <div>
                    <label class="label">Name</label>
                    <input
                      class="input"
                      value={name}
                      onInput={(e) => setName((e.target as HTMLInputElement).value)}
                      placeholder="my-project"
                    />
                    <label class="label" style={{ marginTop: '8px' }}>Repo Path</label>
                    <input
                      class="input"
                      value={repoPath}
                      onInput={(e) => setRepoPath((e.target as HTMLInputElement).value)}
                      placeholder="/home/user/project"
                    />
                    <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                      <button
                        class="btn btn-primary"
                        style={{ flex: 1 }}
                        onClick={handleCreate}
                        disabled={creating}
                      >
                        {creating ? 'Adding...' : 'Add'}
                      </button>
                      <button
                        class="btn"
                        onClick={handleCloseCreate}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <button class="btn btn-primary btn-sm" onClick={() => setShowCreate(true)} style={{ width: '100%' }}>
                + Add Project
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
