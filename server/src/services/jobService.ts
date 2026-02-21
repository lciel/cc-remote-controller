import crypto from 'crypto';
import { ChildProcess } from 'child_process';
import { getDb } from '../db/index.js';
import { Job, JobState } from '../types.js';
import { runClaude } from './claudeRunner.js';
import { broadcast } from '../ws/handler.js';
import * as projectService from './projectService.js';
import { ImageAttachment, saveImages, cleanupImages, cleanupUploadDir } from './imageStore.js';

// In-memory map of running job processes
const runningJobs = new Map<string, ChildProcess>();
// Track image paths per job for cleanup
const jobImagePaths = new Map<string, string[]>();

export function createJob(projectId: string, prompt: string): Job {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO jobs (id, project_id, prompt, state, started_at)
     VALUES (?, ?, ?, 'QUEUED', ?)`
  ).run(id, projectId, prompt, now);

  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job;
}

function updateJobState(jobId: string, state: JobState, exitCode?: number | null): void {
  const db = getDb();
  const ended = state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELED'
    ? new Date().toISOString()
    : null;

  db.prepare(
    `UPDATE jobs SET state = ?, ended_at = COALESCE(?, ended_at), exit_code = COALESCE(?, exit_code) WHERE id = ?`
  ).run(state, ended, exitCode ?? null, jobId);
}

function saveEvent(jobId: string, type: string, payload: unknown): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO events (job_id, ts, type, payload_json) VALUES (?, ?, ?, ?)`
  ).run(jobId, new Date().toISOString(), type, JSON.stringify(payload));
}

export function getJob(jobId: string): Job | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as Job) || null;
}

export function getJobsByProject(projectId: string): Job[] {
  const db = getDb();
  return db.prepare('SELECT * FROM jobs WHERE project_id = ? ORDER BY started_at ASC').all(projectId) as Job[];
}

export function getEventsByJob(jobId: string): unknown[] {
  const db = getDb();
  return db.prepare('SELECT * FROM events WHERE job_id = ? ORDER BY id ASC').all(jobId);
}

/**
 * Get all events for a project across all jobs, in chronological order.
 * Each event includes the job's prompt for chat display.
 */
export function getAllEventsByProject(projectId: string): unknown[] {
  const db = getDb();
  return db.prepare(`
    SELECT e.*, j.prompt as job_prompt
    FROM events e
    JOIN jobs j ON e.job_id = j.id
    WHERE j.project_id = ?
    ORDER BY e.id ASC
  `).all(projectId);
}

export function startJob(projectId: string, repoPath: string, prompt: string, images?: ImageAttachment[]): string {
  const project = projectService.getProject(projectId);
  const job = createJob(projectId, prompt);
  const jobId = job.id;

  // Save images to temp files and append paths to prompt
  let finalPrompt = prompt;
  if (images && images.length > 0) {
    const paths = saveImages(images);
    jobImagePaths.set(jobId, paths);
    finalPrompt += '\n\n[Attached images - use Read tool to view:]\n' + paths.join('\n');
  }

  // Update project state
  projectService.updateProjectState(projectId, 'RUNNING');
  projectService.updateProjectLastJob(projectId, jobId);

  broadcast(projectId, { type: 'project_state', projectId, state: 'RUNNING' });
  broadcast(projectId, { type: 'job_started', projectId, jobId, prompt });

  // Update job to RUNNING
  updateJobState(jobId, 'RUNNING');

  try {
    const child = runClaude({
      repoPath,
      prompt: finalPrompt,
      claudeSessionId: project?.claude_session_id,
    });
    runningJobs.set(jobId, child);

    let stdoutBuffer = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      // Keep the last incomplete line in the buffer
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          const eventType = parsed.type || 'unknown';
          saveEvent(jobId, eventType, parsed);
          broadcast(projectId, {
            type: 'event',
            projectId,
            jobId,
            data: parsed,
          });

          // Capture Claude's session_id from the init or result event
          extractClaudeSessionId(projectId, parsed);
        } catch {
          // Non-JSON line, save as raw
          saveEvent(jobId, 'raw', { raw: line });
          broadcast(projectId, {
            type: 'event',
            projectId,
            jobId,
            data: { type: 'raw', raw: line },
          });
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      saveEvent(jobId, 'stderr', { stderr: text });
      broadcast(projectId, {
        type: 'event',
        projectId,
        jobId,
        data: { type: 'stderr', stderr: text },
      });
    });

    child.on('close', (code) => {
      // Process any remaining buffer
      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer);
          saveEvent(jobId, parsed.type || 'unknown', parsed);
          broadcast(projectId, { type: 'event', projectId, jobId, data: parsed });
          extractClaudeSessionId(projectId, parsed);
        } catch {
          saveEvent(jobId, 'raw', { raw: stdoutBuffer });
        }
      }

      runningJobs.delete(jobId);
      // Cleanup temp images
      const imgPaths = jobImagePaths.get(jobId);
      if (imgPaths) { cleanupImages(imgPaths); jobImagePaths.delete(jobId); }

      const finalState: JobState = code === 0 ? 'SUCCEEDED' : 'FAILED';
      updateJobState(jobId, finalState, code);
      projectService.updateProjectState(projectId, 'IDLE');

      broadcast(projectId, { type: 'job_finished', projectId, jobId, state: finalState });
      broadcast(projectId, { type: 'project_state', projectId, state: 'IDLE' });
    });

    child.on('error', (err) => {
      runningJobs.delete(jobId);
      const imgPaths = jobImagePaths.get(jobId);
      if (imgPaths) { cleanupImages(imgPaths); jobImagePaths.delete(jobId); }
      updateJobState(jobId, 'FAILED');
      projectService.updateProjectState(projectId, 'ERROR');
      saveEvent(jobId, 'error', { error: err.message });

      broadcast(projectId, { type: 'job_finished', projectId, jobId, state: 'FAILED' });
      broadcast(projectId, { type: 'project_state', projectId, state: 'ERROR' });
    });
  } catch (err) {
    updateJobState(jobId, 'FAILED');
    projectService.updateProjectState(projectId, 'ERROR');

    broadcast(projectId, { type: 'job_finished', projectId, jobId, state: 'FAILED' });
    broadcast(projectId, { type: 'project_state', projectId, state: 'ERROR' });
  }

  return jobId;
}

/**
 * Extract and save Claude Code's session ID from stream-json events.
 * The session_id typically appears in "result" or "init" type events.
 */
function extractClaudeSessionId(projectId: string, parsed: Record<string, unknown>): void {
  const claudeSessionId = parsed.session_id as string | undefined;
  if (claudeSessionId) {
    projectService.updateClaudeSessionId(projectId, claudeSessionId);
  }
}

export function cancelJob(jobId: string): boolean {
  const job = getJob(jobId);
  if (!job || (job.state !== 'RUNNING' && job.state !== 'QUEUED')) {
    return false;
  }

  const child = runningJobs.get(jobId);
  if (child) {
    projectService.updateProjectState(job.project_id, 'STOPPING');
    broadcast(job.project_id, {
      type: 'project_state',
      projectId: job.project_id,
      state: 'STOPPING',
    });

    child.kill('SIGTERM');

    // Force kill after 5 seconds if still running
    setTimeout(() => {
      if (runningJobs.has(jobId)) {
        child.kill('SIGKILL');
      }
    }, 5000);
  }

  // Cleanup temp images for this job
  const imgPaths = jobImagePaths.get(jobId);
  if (imgPaths) { cleanupImages(imgPaths); jobImagePaths.delete(jobId); }

  updateJobState(jobId, 'CANCELED');
  return true;
}

/**
 * Cleanup all running processes (called on server shutdown).
 */
export function cleanupAll(): void {
  for (const [jobId, child] of runningJobs) {
    child.kill('SIGTERM');
    runningJobs.delete(jobId);
  }
}
