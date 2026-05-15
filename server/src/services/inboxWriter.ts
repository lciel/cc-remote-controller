import fs from 'fs';
import os from 'os';
import path from 'path';
import { InboxMessage } from './teamRegistry.js';

const TEAMS_ROOT = path.join(os.homedir(), '.claude', 'teams');

const queues = new Map<string, Promise<void>>();

function inboxPath(teamName: string, ownerName: string): string {
  return path.join(TEAMS_ROOT, teamName, 'inboxes', `${ownerName}.json`);
}

function readInbox(p: string): InboxMessage[] {
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeInboxAtomic(p: string, arr: InboxMessage[]): void {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Append a message to a teammate's inbox, serializing concurrent
 * appends within this server process. Does not coordinate with the
 * Claude orchestrator's own writes — collisions are rare enough that
 * read-modify-write + atomic rename is acceptable for MVP.
 */
export function appendInboxMessage(
  teamName: string,
  ownerName: string,
  message: { from: string; text: string; summary?: string; color?: string },
): Promise<InboxMessage> {
  const key = `${teamName}/${ownerName}`;
  const prev = queues.get(key) ?? Promise.resolve();
  let resolveSlot!: () => void;
  const slot = new Promise<void>((r) => { resolveSlot = r; });
  queues.set(key, prev.then(() => slot));

  return prev.then(() => {
    try {
      const p = inboxPath(teamName, ownerName);
      const arr = readInbox(p);
      const entry: InboxMessage = {
        from: message.from,
        text: message.text,
        summary: message.summary,
        timestamp: new Date().toISOString(),
        color: message.color,
        read: false,
      };
      arr.push(entry);
      writeInboxAtomic(p, arr);
      return entry;
    } finally {
      resolveSlot();
      if (queues.get(key) === slot) queues.delete(key);
    }
  });
}
