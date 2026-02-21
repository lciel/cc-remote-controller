import { useState } from 'preact/hooks';
import { useProjects } from '../hooks/useProjects';
import { ProjectCard } from './ProjectCard';
import { api, setToken } from '../api/rest';
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
                    onClick={() => { setShowCreate(false); setName(''); setRepoPath(''); }}
                  >
                    Cancel
                  </button>
                </div>
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
