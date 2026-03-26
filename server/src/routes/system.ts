import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { getDb } from '../db/index.js';
import { broadcastAll } from '../ws/handler.js';

const router = Router();

const MAX_COMMAND_LENGTH = 512;

function getSetting(key: string): string {
  return ((getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value) ?? '';
}

function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

// GET /api/settings
router.get('/settings', (_req: Request, res: Response) => {
  res.json({ wolUrl: getSetting('wolUrl'), sleepCmd: getSetting('sleepCmd') });
});

// PATCH /api/settings
router.patch('/settings', (req: Request, res: Response) => {
  const { wolUrl, sleepCmd } = req.body;
  if (wolUrl !== undefined) {
    if (typeof wolUrl !== 'string') { res.status(400).json({ error: 'wolUrl must be a string' }); return; }
    setSetting('wolUrl', wolUrl.trim());
  }
  if (sleepCmd !== undefined) {
    if (typeof sleepCmd !== 'string') { res.status(400).json({ error: 'sleepCmd must be a string' }); return; }
    if (sleepCmd.length > MAX_COMMAND_LENGTH) { res.status(400).json({ error: `sleepCmd must be ${MAX_COMMAND_LENGTH} characters or fewer` }); return; }
    setSetting('sleepCmd', sleepCmd.trim());
  }
  const updated = { wolUrl: getSetting('wolUrl'), sleepCmd: getSetting('sleepCmd') };
  broadcastAll({ type: 'settings_update', ...updated });
  res.json(updated);
});

// POST /api/system/sleep - Execute the configured sleep/shutdown command.
// Responds immediately, then executes the command with a short delay so the
// response can be delivered before the machine goes down.
router.post('/sleep', (req: Request, res: Response) => {
  const { command } = req.body;
  if (!command || typeof command !== 'string') {
    res.status(400).json({ error: 'command is required' });
    return;
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    res.status(400).json({ error: `command must be ${MAX_COMMAND_LENGTH} characters or fewer` });
    return;
  }

  // Respond before executing so the client receives the ack
  res.json({ message: 'Executing sleep command' });

  setTimeout(() => {
    exec(command, { timeout: 30000 }, (err) => {
      if (err) console.error('[system/sleep] command error:', err.message);
    });
  }, 300);
});

export default router;
