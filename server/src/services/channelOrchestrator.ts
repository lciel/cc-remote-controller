import { spawn } from 'child_process';
import net from 'net';
import path from 'path';
import { config } from '../config.js';
import { broadcast } from '../ws/handler.js';

/**
 * Per-project orchestrator that runs an interactive `claude` session in a
 * detached tmux pane and connects to it through the cc-remote-controller
 * channel plugin (Bun MCP server). All inbound prompts go via POST /push on
 * the plugin's local HTTP port; outbound replies arrive via SSE on /events.
 *
 * Compared to the `-p` (one-shot, stream-json) path, this:
 *   - runs claude in interactive mode (subscription-billed, not -p credit)
 *   - keeps the claude process alive across multiple prompts
 *   - delivers final assistant messages only (no token-level streaming)
 */

const ROOT_DIR = path.resolve(import.meta.dirname, '../../..');
const BUN_PATH =
  process.env.CCCTL_BUN_PATH ??
  '/home/lciel/.local/share/mise/installs/bun/latest/bin/bun';
const MCP_CONFIG_PATH =
  process.env.CCCTL_CHANNEL_MCP_CONFIG ??
  path.join(ROOT_DIR, 'server/channel-plugin/.mcp.json');
const PORT_BASE = 8789;
const HEALTH_TIMEOUT_MS = 20000;
const STARTUP_DELAY_MS = 4000;

interface ChannelSession {
  projectId: string;
  repoPath: string;
  sessionId: string;
  port: number;
  tmuxName: string;
  abort: AbortController;
  startedAt: number;
  currentChatId?: string;
}

const sessions = new Map<string, ChannelSession>();

function sh(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    p.on('error', (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

function tmuxName(projectId: string): string {
  return `ccctl-${projectId.slice(0, 8)}`;
}

async function pickPort(): Promise<number> {
  const used = new Set([...sessions.values()].map((s) => s.port));
  for (let p = PORT_BASE; p < PORT_BASE + 1000; p++) {
    if (used.has(p)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => s.close(() => resolve(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('no free port in 8789..9788 range');
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (r.ok) return;
    } catch {
      /* not ready yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`plugin /health timeout on port ${port}`);
}

function buildClaudeCmd(s: ChannelSession): string {
  // Run via login shell so the user's PATH (mise activation, etc.) applies.
  const sq = (v: string) => v.replace(/'/g, "'\\''");
  const parts = [
    `cd '${sq(s.repoPath)}'`,
    'unset CLAUDECODE',
    `export CCCTL_CHANNEL_PORT=${s.port}`,
    [
      `'${sq(config.claudePath)}'`,
      `--mcp-config '${sq(MCP_CONFIG_PATH)}'`,
      `--dangerously-load-development-channels server:ccctl-channel`,
      `--allowedTools 'mcp__ccctl-channel__reply'`,
      `--session-id '${sq(s.sessionId)}'`,
    ].join(' '),
  ];
  return parts.join(' && ');
}

function onReply(
  s: ChannelSession,
  payload: { chat_id: string; text: string; ts: number },
): void {
  // Synthesize an assistant-message event in the stream-json shape the PWA
  // already understands (see jobService.processStreamLine).
  broadcast(s.projectId, {
    type: 'event',
    projectId: s.projectId,
    jobId: payload.chat_id,
    data: {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: payload.text }],
      },
      session_id: s.sessionId,
    },
  });
  // Mark the "job" finished so the PWA can re-enable input etc.
  broadcast(s.projectId, {
    type: 'job_finished',
    projectId: s.projectId,
    jobId: payload.chat_id,
    state: 'SUCCEEDED',
  });
}

async function streamSse(s: ChannelSession): Promise<void> {
  const url = `http://127.0.0.1:${s.port}/events`;
  try {
    const r = await fetch(url, { signal: s.abort.signal });
    if (!r.ok || !r.body) throw new Error(`SSE init failed: ${r.status}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (event === 'reply' && data) {
          try {
            const parsed = JSON.parse(data) as {
              chat_id: string;
              text: string;
              ts: number;
            };
            onReply(s, parsed);
          } catch {
            /* ignore malformed */
          }
        }
      }
    }
  } catch (err) {
    if (s.abort.signal.aborted) return;
    console.warn(`[channelOrchestrator] SSE stream ended for project ${s.projectId}: ${(err as Error).message}`);
  }
}

export async function ensure(
  projectId: string,
  repoPath: string,
  sessionId: string,
): Promise<ChannelSession> {
  const existing = sessions.get(projectId);
  if (existing) return existing;

  const port = await pickPort();
  const tname = tmuxName(projectId);

  // Pre-kill any stale tmux session with the same name (graceful, ignore error).
  await sh('tmux', ['kill-session', '-t', tname]);

  const session: ChannelSession = {
    projectId,
    repoPath,
    sessionId,
    port,
    tmuxName: tname,
    abort: new AbortController(),
    startedAt: Date.now(),
  };

  const cmd = buildClaudeCmd(session);
  const shell = process.env.SHELL || '/bin/bash';

  // tmux new-session -d runs `shell -lc cmd; tail -f /dev/null` so the pane
  // survives even if claude exits, keeping the session diagnosable.
  const wrapped = `${shell} -lc '${cmd.replace(/'/g, "'\\''")}; tail -f /dev/null'`;
  const r = await sh('tmux', [
    'new-session',
    '-d',
    '-s',
    tname,
    '-x',
    '200',
    '-y',
    '50',
    wrapped,
  ]);
  if (r.code !== 0) {
    throw new Error(`tmux new-session failed: ${r.stderr}`);
  }

  // Give claude a moment to initialize, then blindly send Enter twice to
  // dismiss the dev-channels confirmation and (first-launch) workspace trust
  // dialog. Subsequent runs in the same repo skip the trust prompt.
  await new Promise((r) => setTimeout(r, STARTUP_DELAY_MS));
  await sh('tmux', ['send-keys', '-t', tname, 'Enter']);
  await new Promise((r) => setTimeout(r, 800));
  await sh('tmux', ['send-keys', '-t', tname, 'Enter']);

  // Wait for the Bun channel plugin's /health to come up.
  try {
    await waitForHealth(port);
  } catch (err) {
    await stop(projectId);
    throw err;
  }

  sessions.set(projectId, session);

  // Subscribe to the plugin's SSE event stream in the background.
  void streamSse(session);

  return session;
}

export async function sendPrompt(
  projectId: string,
  content: string,
  opts?: { chat_id?: string; file_path?: string },
): Promise<{ chat_id: string }> {
  const s = sessions.get(projectId);
  if (!s) throw new Error(`channel orchestrator not running for project ${projectId}`);

  // Broadcast user-side message immediately so the PWA renders it.
  const userChatId = opts?.chat_id ?? `u${Date.now()}`;
  broadcast(s.projectId, {
    type: 'event',
    projectId: s.projectId,
    jobId: userChatId,
    data: {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: content }],
      },
      session_id: s.sessionId,
    },
  });
  broadcast(s.projectId, {
    type: 'job_started',
    projectId: s.projectId,
    jobId: userChatId,
    prompt: content,
  });

  const body: Record<string, unknown> = { content, chat_id: userChatId };
  if (opts?.file_path) body.file_path = opts.file_path;

  const r = await fetch(`http://127.0.0.1:${s.port}/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`/push returned ${r.status}`);
  }
  const data = (await r.json()) as { ok: boolean; chat_id: string };
  s.currentChatId = data.chat_id;
  return { chat_id: data.chat_id };
}

export async function stop(projectId: string): Promise<void> {
  const s = sessions.get(projectId);
  if (!s) return;
  s.abort.abort();
  await sh('tmux', ['kill-session', '-t', s.tmuxName]);
  sessions.delete(projectId);
}

export function isRunning(projectId: string): boolean {
  return sessions.has(projectId);
}

export function list(): Array<{
  projectId: string;
  port: number;
  startedAt: number;
}> {
  return Array.from(sessions.values()).map((s) => ({
    projectId: s.projectId,
    port: s.port,
    startedAt: s.startedAt,
  }));
}
