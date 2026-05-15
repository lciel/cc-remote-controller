export type ProjectState = 'IDLE' | 'RUNNING' | 'STOPPING' | 'ERROR';
export type JobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

export interface Project {
  id: string;
  name: string;
  repo_path: string;
  state: ProjectState;
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
  state: JobState;
  started_at: string | null;
  ended_at: string | null;
  exit_code: number | null;
}

export interface Event {
  id: number;
  job_id: string;
  ts: string;
  type: string;
  payload_json: string;
}

// WebSocket message types
export type WsClientMessage =
  | { type: 'subscribe'; projectId: string }
  | { type: 'unsubscribe'; projectId: string };

export type WsServerMessage =
  | { type: 'project_state'; projectId: string; state: ProjectState }
  | { type: 'job_started'; projectId: string; jobId: string; prompt: string }
  | { type: 'job_finished'; projectId: string; jobId: string; state: JobState }
  | { type: 'event'; projectId: string; jobId: string; data: unknown }
  | { type: 'team_update'; projectId: string }
  | { type: 'settings_update'; wolUrl: string; sleepCmd: string };
