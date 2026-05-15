import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { Project, ProjectState } from '../types.js';

export function createProject(name: string, repoPath: string): Project {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO projects (id, name, repo_path, state, created_at, updated_at)
     VALUES (?, ?, ?, 'IDLE', ?, ?)`
  ).run(id, name, repoPath, now, now);

  return getProject(id)!;
}

export function listProjects(): Project[] {
  const db = getDb();
  return db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Project[];
}

export function getProject(id: string): Project | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project) || null;
}

export function updateProjectState(id: string, state: ProjectState): void {
  const db = getDb();
  db.prepare(
    `UPDATE projects SET state = ?, updated_at = ? WHERE id = ?`
  ).run(state, new Date().toISOString(), id);
}

export function updateProjectLastJob(id: string, jobId: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE projects SET last_job_id = ?, updated_at = ? WHERE id = ?`
  ).run(jobId, new Date().toISOString(), id);
}

export function updateClaudeSessionId(id: string, claudeSessionId: string | null): void {
  const db = getDb();
  db.prepare(
    `UPDATE projects SET claude_session_id = ?, updated_at = ? WHERE id = ?`
  ).run(claudeSessionId, new Date().toISOString(), id);
}

export function updateModel(id: string, model: string | null): void {
  const db = getDb();
  db.prepare(
    `UPDATE projects SET model = ?, updated_at = ? WHERE id = ?`
  ).run(model, new Date().toISOString(), id);
}

export function updateTeamMode(id: string, teamMode: boolean): void {
  const db = getDb();
  db.prepare(
    `UPDATE projects SET team_mode = ?, updated_at = ? WHERE id = ?`
  ).run(teamMode ? 1 : 0, new Date().toISOString(), id);
}

export function deleteProject(id: string): boolean {
  const db = getDb();
  db.prepare('DELETE FROM events WHERE job_id IN (SELECT id FROM jobs WHERE project_id = ?)').run(id);
  db.prepare('DELETE FROM jobs WHERE project_id = ?').run(id);
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  return result.changes > 0;
}
