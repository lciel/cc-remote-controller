import fs from 'fs';
import os from 'os';
import path from 'path';

const TEAMS_ROOT = path.join(os.homedir(), '.claude', 'teams');

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

export interface InboxMessage {
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
  inboxes: Record<string, InboxMessage[]>;
}

interface TeamConfig {
  name: string;
  description?: string;
  createdAt?: number;
  leadSessionId: string;
  leadAgentId?: string;
  members: TeamMember[];
}

function readJsonSafe<T>(p: string): T | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function listTeamDirs(): string[] {
  if (!fs.existsSync(TEAMS_ROOT)) return [];
  try {
    return fs.readdirSync(TEAMS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * Find the team whose leadSessionId matches the given Claude session.
 * Returns the team's directory name or null. If multiple teams match
 * (should not happen), the most recently created one wins.
 */
export function findTeamByLeadSession(sessionId: string): string | null {
  let best: { name: string; createdAt: number } | null = null;
  for (const name of listTeamDirs()) {
    const cfg = readJsonSafe<TeamConfig>(path.join(TEAMS_ROOT, name, 'config.json'));
    if (!cfg || cfg.leadSessionId !== sessionId) continue;
    const createdAt = cfg.createdAt ?? 0;
    if (!best || createdAt > best.createdAt) best = { name, createdAt };
  }
  return best?.name ?? null;
}

export function readTeamSnapshot(teamName: string): TeamSnapshot | null {
  const cfgPath = path.join(TEAMS_ROOT, teamName, 'config.json');
  const cfg = readJsonSafe<TeamConfig>(cfgPath);
  if (!cfg) return null;

  const inboxesDir = path.join(TEAMS_ROOT, teamName, 'inboxes');
  const inboxes: Record<string, InboxMessage[]> = {};
  if (fs.existsSync(inboxesDir)) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(inboxesDir); } catch { /* ignore */ }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue;
      const owner = file.slice(0, -5);
      const msgs = readJsonSafe<InboxMessage[]>(path.join(inboxesDir, file));
      if (Array.isArray(msgs)) inboxes[owner] = msgs;
    }
  }

  return {
    teamName: cfg.name,
    description: cfg.description,
    leadSessionId: cfg.leadSessionId,
    createdAt: cfg.createdAt,
    members: cfg.members ?? [],
    inboxes,
  };
}

/**
 * Cheap fingerprint of a team's inbox state (mtime + size of each inbox JSON).
 * Used by the watcher to detect changes without comparing content.
 */
export function inboxFingerprint(teamName: string): string {
  const inboxesDir = path.join(TEAMS_ROOT, teamName, 'inboxes');
  if (!fs.existsSync(inboxesDir)) return '';
  let entries: string[] = [];
  try { entries = fs.readdirSync(inboxesDir).sort(); } catch { return ''; }
  const parts: string[] = [];
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    try {
      const st = fs.statSync(path.join(inboxesDir, file));
      parts.push(`${file}:${st.mtimeMs}:${st.size}`);
    } catch { /* ignore */ }
  }
  return parts.join('|');
}
