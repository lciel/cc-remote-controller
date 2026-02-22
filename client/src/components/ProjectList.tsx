import { useState, useEffect } from 'preact/hooks';
import { useProjects } from '../hooks/useProjects';
import { ProjectCard } from './ProjectCard';
import { api, setToken, DiscoveredProject } from '../api/rest';
import { reconnectWs } from '../hooks/useWebSocket';
import { usePageVisibility } from '../hooks/usePageVisibility';

interface Props {
  path?: string;
}

export function ProjectList(_props: Props) {
  const { projects, loading, error, refresh } = useProjects();
  usePageVisibility(refresh);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [tokenInput, setTokenInput] = useState(
    localStorage.getItem('cc-auth-token') || ''
  );

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

  const handleDelete = async (id: string) => {
    try {
      await api.deleteProject(id);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  };

  const handleSaveToken = () => {
    setToken(tokenInput);
    reconnectWs();
    setShowSettings(false);
    refresh();
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
        <h1>CC Remote</h1>
        <div class="header-actions">
          <button class="btn-icon header-icon-btn" onClick={() => { setShowSettings(!showSettings); setShowCreate(false); }} aria-label="Settings">
            {showSettings ? '\u2716' : '\u2699'}
          </button>
        </div>
      </header>

      {showSettings && (
        <div class="card">
          <label class="label">Auth Token</label>
          <input
            type="password"
            class="input"
            value={tokenInput}
            onInput={(e) => setTokenInput((e.target as HTMLInputElement).value)}
          />
          <button class="btn btn-primary" style={{ marginTop: '8px' }} onClick={handleSaveToken}>
            Save
          </button>
        </div>
      )}

      {loading && <div class="loading">Loading...</div>}
      {error && <div class="error">{error}</div>}

      <div class="project-list">
        {projects.map((p) => (
          <ProjectCard key={p.id} project={p} editing={showSettings} onDelete={handleDelete} />
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
