function getToken(): string {
  return localStorage.getItem('cc-auth-token') || '';
}

export function setToken(token: string): void {
  localStorage.setItem('cc-auth-token', token);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getToken()}`,
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  return res.json();
}

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  state: string;
  created_at: string;
  updated_at: string;
  last_job_id: string | null;
  claude_session_id: string | null;
  model: string | null;
  team_mode: number;
}

export interface Job {
  id: string;
  project_id: string;
  prompt: string;
  state: string;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
}

export interface DiscoveredProject {
  path: string;
  name: string;
}

export interface ClaudeConversation {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  modifiedAt: string;
}

export const api = {
  listProjects: () => request<Project[]>('/api/projects'),

  discoverProjects: () => request<DiscoveredProject[]>('/api/projects/discover'),

  browseDirectories: (dirPath?: string) =>
    request<{ current: string; dirs: { name: string; path: string }[] }>(
      `/api/projects/browse${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`
    ),

  getProject: (id: string) => request<Project>(`/api/projects/${id}`),

  createProject: (name: string, repoPath: string, createDir?: boolean) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, repoPath, createDir }),
    }),

  runJob: (projectId: string, prompt: string, images?: ImageAttachment[]) =>
    request<{ jobId: string }>(`/api/projects/${projectId}/run`, {
      method: 'POST',
      body: JSON.stringify({ prompt, images }),
    }),

  cancelJob: (jobId: string) =>
    request<{ message: string }>(`/api/jobs/${jobId}/cancel`, {
      method: 'POST',
    }),

  getProjectJobs: (projectId: string) =>
    request<Job[]>(`/api/projects/${projectId}/jobs`),

  getProjectEvents: (projectId: string) =>
    request<unknown[]>(`/api/projects/${projectId}/events`),

  updateProject: (projectId: string, data: { claudeSessionId?: string | null; model?: string | null; teamMode?: boolean }) =>
    request<Project>(`/api/projects/${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getClaudeConversations: (projectId: string) =>
    request<ClaudeConversation[]>(`/api/projects/${projectId}/conversations`),

  getClaudeHistory: (projectId: string) =>
    request<ClaudeHistoryMessage[]>(`/api/projects/${projectId}/history`),

  getContextUsage: (projectId: string) =>
    request<ContextUsage | null>(`/api/projects/${projectId}/context`),

  getGitBranch: (projectId: string) =>
    request<{ branch: string | null }>(`/api/projects/${projectId}/git-branch`),

  listFiles: (projectId: string, relPath?: string) =>
    request<{ current: string; items: FileItem[] }>(
      `/api/projects/${projectId}/files${relPath ? `?path=${encodeURIComponent(relPath)}` : ''}`
    ),

  readFile: (projectId: string, relPath: string) =>
    request<{ path: string; size: number; binary: boolean; content: string | null }>(
      `/api/projects/${projectId}/file?path=${encodeURIComponent(relPath)}`
    ),

  checkFilesExist: (projectId: string, paths: string[]) =>
    request<{ results: Record<string, boolean> }>(`/api/projects/${projectId}/files-exist`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),

  getToolResult: (projectId: string, toolUseId: string) =>
    request<{ result: string | null }>(`/api/projects/${projectId}/tool-result/${toolUseId}`),

  deleteProject: (projectId: string) =>
    request<{ message: string }>(`/api/projects/${projectId}`, {
      method: 'DELETE',
    }),

  sleepSystem: (command: string) =>
    request<{ message: string }>('/api/system/sleep', {
      method: 'POST',
      body: JSON.stringify({ command }),
    }),

  getSettings: () =>
    request<{ wolUrl: string; sleepCmd: string }>('/api/system/settings'),

  updateSettings: (data: { wolUrl?: string; sleepCmd?: string }) =>
    request<{ wolUrl: string; sleepCmd: string }>('/api/system/settings', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  getAnalyses: () =>
    request<AnalysisStatus[]>('/api/analyses'),

  runAnalysis: (projectId: string) =>
    request<{ status: string }>(`/api/analyses/${projectId}/run`, { method: 'POST' }),

  runAllAnalyses: () =>
    request<{ status: string; count: number }>('/api/analyses/run-all', { method: 'POST' }),

  getTeam: (projectId: string) =>
    request<{ team: TeamSnapshot | null }>(`/api/projects/${projectId}/team`),

  sendTeammateMessage: (projectId: string, name: string, body: { text: string; summary?: string }) =>
    request<{ ok: true; message: TeamInboxMessage }>(
      `/api/projects/${projectId}/teammates/${encodeURIComponent(name)}/messages`,
      { method: 'POST', body: JSON.stringify(body) }
    ),
};

export interface TeamMember {
  agentId: string;
  name: string;
  agentType?: string;
  model?: string;
  color?: string;
  backendType?: string;
  joinedAt?: number;
  cwd?: string;
}

export interface TeamInboxMessage {
  from: string;
  text: string;
  summary?: string;
  timestamp: string;
  color?: string;
  read: boolean;
}

export interface TeamSnapshot {
  teamName: string;
  description?: string;
  leadSessionId: string;
  createdAt?: number;
  members: TeamMember[];
  inboxes: Record<string, TeamInboxMessage[]>;
}

export interface FileItem {
  name: string;
  type: 'dir' | 'file';
  size: number;
  mtime: number;
  path: string;
}

export interface AnalysisStatus {
  projectId: string;
  projectName: string;
  repoPath: string;
  state: 'idle' | 'running' | 'done' | 'error';
  summary?: string;
  analyzed_at?: string;
  stale?: boolean;
}

export interface ImageAttachment {
  data: string;       // base64-encoded
  mediaType: string;  // e.g. "image/png" or "application/pdf"
  filename?: string;  // original filename — preferred for extension hint when mediaType is generic
}

export interface ContextUsage {
  used: number;
  limit: number;
  model: string | null;
}

export interface ClaudeHistoryMessage {
  role: 'user' | 'assistant';
  content: unknown;
  timestamp: string;
}
