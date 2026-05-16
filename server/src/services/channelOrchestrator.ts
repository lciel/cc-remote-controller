import { spawn } from 'child_process';
import { stat, open as fsOpen } from 'fs/promises';
import { homedir } from 'os';
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
  isNew: boolean;
  port: number;
  tmuxName: string;
  abort: AbortController;
  startedAt: number;
  currentChatId?: string;
  jsonlPath: string;
  jsonlOffset: number; // bytes already read from jsonl; -1 = not yet found
}

const JSONL_POLL_MS = 200;
const JSONL_FIND_TIMEOUT_MS = 30000;

function jsonlPathFor(repoPath: string, sessionId: string): string {
  // claude code encodes the project root path by replacing '/' with '-'.
  const encoded = repoPath.replace(/\//g, '-');
  return path.join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
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
  // --session-id creates a new session with the given id (fails if it exists);
  // --resume continues an existing session. Use --resume when the project
  // already has a stored claude_session_id (matches the -p path's behavior).
  const sq = (v: string) => v.replace(/'/g, "'\\''");
  const sessionFlag = s.isNew
    ? `--session-id '${sq(s.sessionId)}'`
    : `--resume '${sq(s.sessionId)}'`;
  const parts = [
    `cd '${sq(s.repoPath)}'`,
    'unset CLAUDECODE',
    `export CCCTL_CHANNEL_PORT=${s.port}`,
    [
      `'${sq(config.claudePath)}'`,
      `--mcp-config '${sq(MCP_CONFIG_PATH)}'`,
      `--dangerously-load-development-channels server:ccctl-channel`,
      `--allowedTools 'mcp__ccctl-channel__reply Bash Edit Write Read Glob Grep NotebookEdit WebFetch WebSearch SendMessage Agent TeamCreate TeamDelete ToolSearch'`,
      sessionFlag,
    ].join(' '),
  ];
  return parts.join(' && ');
}

const REPLY_TOOL_NAME = 'mcp__ccctl-channel__reply';

function processJsonlLine(s: ChannelSession, line: string): void {
  type ContentBlock = {
    type?: string;
    text?: string;
    name?: string;
    input?: { text?: string };
    tool_use_id?: string;
    content?: unknown;
  };
  type JsonlEntry = {
    type?: string;
    message?: {
      role?: string;
      content?: unknown;
      stop_reason?: string | null;
    };
  };
  let parsed: JsonlEntry;
  try {
    parsed = JSON.parse(line) as JsonlEntry;
  } catch {
    return;
  }

  if (parsed.type !== 'user' && parsed.type !== 'assistant') return;

  // Skip resume artifacts and channel-tagged user prompts (the PWA already
  // displays the prompt via job_started.prompt).
  if (parsed.type === 'user') {
    const content = parsed.message?.content;
    const firstText = (() => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const t = (content as ContentBlock[]).find((c) => c?.type === 'text');
        return t?.text ?? '';
      }
      return '';
    })();
    if (
      firstText === 'Continue from where you left off.' ||
      /<channel\s+source="ccctl-channel"/.test(firstText)
    ) {
      return;
    }

    // Skip tool_result entries from the reply tool (e.g. "sent (chat_id=...)").
    if (Array.isArray(content)) {
      const blocks = content as ContentBlock[];
      const onlyReplyTr =
        blocks.length === 1 &&
        blocks[0]?.type === 'tool_result' &&
        typeof blocks[0]?.content === 'string' &&
        /^sent \(chat_id=/.test(blocks[0].content);
      if (onlyReplyTr) return;
    }
  }

  // For assistant messages, transform mcp__ccctl-channel__reply tool_use into
  // a plain text block so the PWA renders the reply text instead of a
  // collapsed tool call.
  let outMessage = parsed.message;
  if (parsed.type === 'assistant' && Array.isArray(outMessage?.content)) {
    const transformed: ContentBlock[] = [];
    for (const b of outMessage.content as ContentBlock[]) {
      if (b?.type === 'tool_use' && b?.name === REPLY_TOOL_NAME) {
        const text = b.input?.text;
        if (typeof text === 'string' && text.length > 0) {
          transformed.push({ type: 'text', text });
        }
      } else {
        transformed.push(b);
      }
    }
    if (transformed.length === 0) return;
    outMessage = { ...outMessage, content: transformed };
  }

  broadcast(s.projectId, {
    type: 'event',
    projectId: s.projectId,
    jobId: s.currentChatId ?? s.sessionId,
    data: {
      type: parsed.type,
      message: outMessage,
      session_id: s.sessionId,
    },
  });

  // Detect end-of-turn (final assistant message) → mark job finished.
  if (
    parsed.type === 'assistant' &&
    parsed.message?.stop_reason === 'end_turn'
  ) {
    broadcast(s.projectId, {
      type: 'job_finished',
      projectId: s.projectId,
      jobId: s.currentChatId ?? s.sessionId,
      state: 'SUCCEEDED',
    });
  }
}

async function watchJsonl(s: ChannelSession): Promise<void> {
  // Wait for the jsonl file to appear (claude creates it on first turn).
  const findDeadline = Date.now() + JSONL_FIND_TIMEOUT_MS;
  while (Date.now() < findDeadline && !s.abort.signal.aborted) {
    try {
      const st = await stat(s.jsonlPath);
      s.jsonlOffset = st.size;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (s.abort.signal.aborted || s.jsonlOffset < 0) return;

  let leftover = '';
  while (!s.abort.signal.aborted) {
    await new Promise((r) => setTimeout(r, JSONL_POLL_MS));
    let st;
    try {
      st = await stat(s.jsonlPath);
    } catch {
      continue;
    }
    if (st.size <= s.jsonlOffset) continue;
    const len = st.size - s.jsonlOffset;
    try {
      const fh = await fsOpen(s.jsonlPath, 'r');
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, s.jsonlOffset);
      await fh.close();
      s.jsonlOffset = st.size;
      const chunk = leftover + buf.toString('utf-8');
      const lines = chunk.split('\n');
      leftover = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) processJsonlLine(s, line);
      }
    } catch (err) {
      console.warn(
        `[channelOrchestrator] jsonl read failed for ${s.projectId}: ${(err as Error).message}`,
      );
    }
  }
}

export async function ensure(
  projectId: string,
  repoPath: string,
  sessionId: string,
  isNew: boolean,
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
    isNew,
    port,
    tmuxName: tname,
    abort: new AbortController(),
    startedAt: Date.now(),
    jsonlPath: jsonlPathFor(repoPath, sessionId),
    jsonlOffset: -1,
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

  // Tail the claude session's jsonl in the background to broadcast
  // assistant/user/tool events to the PWA in real time.
  void watchJsonl(session);

  return session;
}

export async function sendPrompt(
  projectId: string,
  content: string,
  opts?: { chat_id?: string; file_path?: string },
): Promise<{ chat_id: string }> {
  const s = sessions.get(projectId);
  if (!s) throw new Error(`channel orchestrator not running for project ${projectId}`);

  // Notify the PWA that a job is starting; the prompt itself is rendered
  // from job_started.prompt (matching the -p path's flow).
  const userChatId = opts?.chat_id ?? `u${Date.now()}`;
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
