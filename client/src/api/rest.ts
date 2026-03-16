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

  getProject: (id: string) => request<Project>(`/api/projects/${id}`),

  createProject: (name: string, repoPath: string) =>
    request<Project>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, repoPath }),
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

  updateProject: (projectId: string, data: { claudeSessionId?: string | null }) =>
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

  deleteProject: (projectId: string) =>
    request<{ message: string }>(`/api/projects/${projectId}`, {
      method: 'DELETE',
    }),
};

export interface ImageAttachment {
  data: string;       // base64-encoded
  mediaType: string;  // e.g. "image/png"
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
