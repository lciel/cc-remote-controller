import * as projectService from './projectService.js';
import * as teamRegistry from './teamRegistry.js';
import { broadcast } from '../ws/handler.js';

const POLL_INTERVAL_MS = 1000;

let timer: ReturnType<typeof setInterval> | null = null;
const lastFingerprints = new Map<string, string>();

function tick(): void {
  let projects: ReturnType<typeof projectService.listProjects>;
  try {
    projects = projectService.listProjects().filter((p) => p.team_mode);
  } catch {
    return;
  }

  const seenProjectIds = new Set<string>();
  for (const project of projects) {
    seenProjectIds.add(project.id);
    if (!project.claude_session_id) continue;
    const teamName = teamRegistry.findTeamByLeadSession(project.claude_session_id);
    if (!teamName) {
      if (lastFingerprints.has(project.id)) {
        lastFingerprints.delete(project.id);
        broadcast(project.id, { type: 'team_update', projectId: project.id });
      }
      continue;
    }
    const fp = teamRegistry.inboxFingerprint(teamName);
    if (lastFingerprints.get(project.id) !== fp) {
      lastFingerprints.set(project.id, fp);
      broadcast(project.id, { type: 'team_update', projectId: project.id });
    }
  }

  for (const id of Array.from(lastFingerprints.keys())) {
    if (!seenProjectIds.has(id)) lastFingerprints.delete(id);
  }
}

export function start(): void {
  if (timer) return;
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stop(): void {
  if (timer) { clearInterval(timer); timer = null; }
  lastFingerprints.clear();
}
