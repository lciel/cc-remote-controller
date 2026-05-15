import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { runClaudePersistent } from './claudeRunner.js';
import { broadcast } from '../ws/handler.js';
import * as projectService from './projectService.js';
import { saveEvent, updateJobState } from './jobService.js';

interface OrchestratorState {
  child: ChildProcess;
  projectId: string;
  sessionId: string | null;
  currentJobId: string | null;
  stdoutBuffer: string;
}

const orchestrators = new Map<string, OrchestratorState>();

export function isRunning(projectId: string): boolean {
  return orchestrators.has(projectId);
}

export function getSessionId(projectId: string): string | null {
  return orchestrators.get(projectId)?.sessionId ?? null;
}

/**
 * Ensure a persistent orchestrator process is running for the project.
 * Lazy-spawns on first call. Safe to call repeatedly.
 */
export function ensure(
  projectId: string,
  repoPath: string,
  model: string | null,
  claudeSessionId: string | null,
): void {
  if (orchestrators.has(projectId)) return;

  const child = runClaudePersistent({ repoPath, claudeSessionId, model });
  const state: OrchestratorState = {
    child,
    projectId,
    sessionId: claudeSessionId,
    currentJobId: null,
    stdoutBuffer: '',
  };
  orchestrators.set(projectId, state);

  child.stdout?.on('data', (chunk: Buffer) => handleStdout(state, chunk));
  child.stderr?.on('data', (chunk: Buffer) => handleStderr(state, chunk));
  child.on('close', (code) => handleClose(state, code));
  child.on('error', (err) => handleError(state, err));
}

/**
 * Adopt jobId as the orchestrator's current turn and write a user message
 * to stdin. The persistent process processes one turn and emits a `result`
 * event when done; we use that to mark the job complete.
 */
export function sendUserMessage(projectId: string, prompt: string, jobId: string): void {
  const state = orchestrators.get(projectId);
  if (!state) {
    throw new Error('orchestrator not running for project ' + projectId);
  }
  if (state.currentJobId) {
    throw new Error('orchestrator busy with job ' + state.currentJobId);
  }
  if (!state.child.stdin || !state.child.stdin.writable) {
    throw new Error('orchestrator stdin not writable');
  }
  state.currentJobId = jobId;
  const msg = { type: 'user', message: { role: 'user', content: prompt } };
  state.child.stdin.write(JSON.stringify(msg) + '\n');
}

/**
 * Gracefully stop the orchestrator (and its team via Claude's own shutdown).
 */
export function stop(projectId: string): void {
  const state = orchestrators.get(projectId);
  if (!state) return;
  try { state.child.stdin?.end(); } catch { /* ignore */ }
  state.child.kill('SIGTERM');
  setTimeout(() => {
    if (orchestrators.has(projectId)) {
      try { state.child.kill('SIGKILL'); } catch { /* ignore */ }
    }
  }, 5000);
}

/**
 * Stop every running orchestrator (for server shutdown).
 */
export function shutdownAll(): void {
  for (const projectId of Array.from(orchestrators.keys())) {
    stop(projectId);
  }
}

function handleStdout(state: OrchestratorState, chunk: Buffer): void {
  state.stdoutBuffer += chunk.toString();
  const lines = state.stdoutBuffer.split('\n');
  state.stdoutBuffer = lines.pop() || '';
  for (const line of lines) {
    processLine(state, line);
  }
}

function processLine(state: OrchestratorState, line: string): void {
  if (!line.trim()) return;
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line);
  } catch {
    if (state.currentJobId) {
      saveEvent(state.currentJobId, 'raw', { raw: line });
      broadcast(state.projectId, {
        type: 'event',
        projectId: state.projectId,
        jobId: state.currentJobId,
        data: { type: 'raw', raw: line },
      });
    }
    return;
  }

  const sid = parsed && (parsed.session_id as string | undefined);
  if (sid && state.sessionId !== sid) {
    state.sessionId = sid;
    projectService.updateClaudeSessionId(state.projectId, sid);
  }

  if (state.currentJobId) {
    const eventType = (parsed?.type as string | undefined) || 'unknown';
    saveEvent(state.currentJobId, eventType, parsed);
    broadcast(state.projectId, {
      type: 'event',
      projectId: state.projectId,
      jobId: state.currentJobId,
      data: parsed,
    });
    if (eventType === 'result') {
      finishCurrentJob(state, parsed);
    }
  }
}

function finishCurrentJob(state: OrchestratorState, resultEvent: Record<string, unknown> | null): void {
  const jobId = state.currentJobId;
  if (!jobId) return;
  state.currentJobId = null;
  const subtype = resultEvent?.subtype as string | undefined;
  const succeeded = subtype !== 'error_during_execution' && subtype !== 'error_max_turns';
  const finalState = succeeded ? 'SUCCEEDED' : 'FAILED';
  updateJobState(jobId, finalState);
  projectService.updateProjectState(state.projectId, 'IDLE');
  broadcast(state.projectId, {
    type: 'job_finished',
    projectId: state.projectId,
    jobId,
    state: finalState,
  });
  broadcast(state.projectId, {
    type: 'project_state',
    projectId: state.projectId,
    state: 'IDLE',
  });
}

function handleStderr(state: OrchestratorState, chunk: Buffer): void {
  const text = chunk.toString();
  if (state.currentJobId) {
    saveEvent(state.currentJobId, 'stderr', { stderr: text });
    broadcast(state.projectId, {
      type: 'event',
      projectId: state.projectId,
      jobId: state.currentJobId,
      data: { type: 'stderr', stderr: text },
    });
  }
}

function handleClose(state: OrchestratorState, code: number | null): void {
  orchestrators.delete(state.projectId);
  if (state.currentJobId) {
    const jobId = state.currentJobId;
    state.currentJobId = null;
    saveEvent(jobId, 'orchestrator_closed', { exit_code: code });
    updateJobState(jobId, 'FAILED', code);
    broadcast(state.projectId, {
      type: 'job_finished',
      projectId: state.projectId,
      jobId,
      state: 'FAILED',
    });
  }
  projectService.updateProjectState(state.projectId, 'IDLE');
  broadcast(state.projectId, {
    type: 'project_state',
    projectId: state.projectId,
    state: 'IDLE',
  });
}

function handleError(state: OrchestratorState, err: Error): void {
  if (state.currentJobId) {
    saveEvent(state.currentJobId, 'error', { error: err.message });
  }
}

/**
 * Read PPID from /proc/<pid>/stat. The "comm" field can contain spaces and
 * parens, so parse from the LAST ')' to be safe.
 */
function readPpid(pid: number): number | null {
  let stat: string;
  try {
    stat = fs.readFileSync(path.join('/proc', String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  const lastParen = stat.lastIndexOf(')');
  if (lastParen === -1) return null;
  // After the closing paren: " <state> <ppid> <pgrp> ..."
  const fields = stat.slice(lastParen + 2).split(' ');
  const ppid = parseInt(fields[1], 10);
  return Number.isFinite(ppid) ? ppid : null;
}

/**
 * Find PIDs of persistent claude orchestrator processes whose --resume
 * argument matches one of the given session IDs. Reads /proc/<pid>/cmdline
 * directly so we don't depend on `ps` formatting.
 *
 * Only returns processes that are TRUE orphans (PPID = 1, re-parented to init
 * after the previous server died). This prevents the new server from killing
 * a still-living lead orchestrator — including its own ancestor when the
 * server is invoked from inside a team-mode claude code session.
 */
function findOrphanPids(sessionIds: Set<string>): number[] {
  const result: number[] = [];
  let entries: string[];
  try { entries = fs.readdirSync('/proc'); } catch { return result; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = fs.readFileSync(path.join('/proc', entry, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    const args = cmdline.split('\0').filter((s) => s.length > 0);
    if (args.length === 0) continue;
    const argv0 = args[0];
    if (!/(^|\/)claude$/.test(argv0)) continue;
    const inputFmtIdx = args.indexOf('--input-format');
    if (inputFmtIdx === -1 || args[inputFmtIdx + 1] !== 'stream-json') continue;
    const resumeIdx = args.indexOf('--resume');
    if (resumeIdx === -1) continue;
    const resumeId = args[resumeIdx + 1];
    if (!resumeId || !sessionIds.has(resumeId)) continue;
    // True orphan only: parent died and the process was re-parented to init.
    // A live parent means the orchestrator is still actively managed
    // (e.g. by a running ccctl server) and must not be killed.
    const ppid = readPpid(pid);
    if (ppid !== 1) continue;
    result.push(pid);
  }
  return result;
}

/**
 * Look for orphan persistent-orchestrator processes left over from a
 * previous server instance and SIGTERM them. Graceful shutdown lets
 * Claude clean up its team config so the next ensure() starts fresh.
 *
 * Run once on server startup, before teamWatcher.start() and any new
 * orchestrators are spawned.
 */
export function cleanupOrphans(): void {
  let projects: ReturnType<typeof projectService.listProjects>;
  try {
    projects = projectService.listProjects().filter((p) => p.team_mode && p.claude_session_id);
  } catch {
    return;
  }
  if (projects.length === 0) return;
  const sessionIds = new Set<string>(projects.map((p) => p.claude_session_id as string));
  const pids = findOrphanPids(sessionIds);
  if (pids.length === 0) return;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`[orphan-cleanup] SIGTERM pid=${pid}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        console.warn(`[orphan-cleanup] kill pid=${pid} failed: ${(err as Error).message}`);
      }
    }
  }
}
