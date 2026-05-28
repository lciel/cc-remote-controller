import { spawn, execFileSync } from 'child_process';
import { stat, open as fsOpen } from 'fs/promises';
import { writeFileSync, existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import net from 'net';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { config } from '../config.js';
import { broadcast } from '../ws/handler.js';
import * as projectService from './projectService.js';

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
const CHANNEL_PLUGIN_DIR = path.join(ROOT_DIR, 'server/channel-plugin');
// .mcp.json is read directly by claude (no env expansion), so we generate it
// at runtime with a resolved bun path into a git-ignored file.
const MCP_CONFIG_PATH =
  process.env.CCCTL_CHANNEL_MCP_CONFIG ??
  path.join(CHANNEL_PLUGIN_DIR, '.mcp.generated.json');
const BUN_FALLBACK_PATH =
  '/home/lciel/.local/share/mise/installs/bun/latest/bin/bun';
const PORT_BASE = 8789;
const HEALTH_TIMEOUT_MS = 20000;
const STARTUP_DELAY_MS = 4000;
const CLAUDE_READY_TIMEOUT_MS = 60000;

let cachedBunPath: string | null = null;

function trySh(cmd: string, args: string[]): string | null {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Scan /proc for a live `claude` process whose --resume or --session-id
 * argument equals the given session id. Returns its pid, or null. Used to
 * detect "self-session" collisions (e.g. a project bound to the very session
 * currently driving the controller) before we --resume it. Linux/WSL2 only,
 * consistent with persistentOrchestrator's /proc scanning.
 */
function findLiveClaudePid(sessionId: string): number | null {
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue;
    let cmdline: string;
    try {
      cmdline = readFileSync(path.join('/proc', entry, 'cmdline'), 'utf8');
    } catch {
      continue;
    }
    const args = cmdline.split('\0').filter((s) => s.length > 0);
    if (args.length === 0) continue;
    if (!/(^|\/)claude$/.test(args[0])) continue;
    const ri = args.indexOf('--resume');
    if (ri !== -1 && args[ri + 1] === sessionId) return pid;
    const si = args.indexOf('--session-id');
    if (si !== -1 && args[si + 1] === sessionId) return pid;
  }
  return null;
}

function resolveBunPath(): string {
  if (cachedBunPath) return cachedBunPath;
  const candidates: Array<string | null> = [
    process.env.CCCTL_BUN_PATH?.trim() || null,
    trySh('mise', ['which', 'bun']),
    trySh('bash', ['-lc', 'command -v bun']),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) {
      cachedBunPath = c;
      return c;
    }
  }
  cachedBunPath = BUN_FALLBACK_PATH;
  return BUN_FALLBACK_PATH;
}

// Write .mcp.generated.json that declares how claude should spawn the
// channel plugin. Called before each claude launch so the bun path /
// repo location track the current environment instead of being hardcoded.
function writeMcpConfig(): void {
  const cfg = {
    mcpServers: {
      'ccctl-channel': {
        command: resolveBunPath(),
        args: [path.join(CHANNEL_PLUGIN_DIR, 'server.ts')],
      },
    },
  };
  writeFileSync(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

interface ChannelSession {
  projectId: string;
  repoPath: string;
  sessionId: string;
  isNew: boolean;
  model: string | null;
  port: number;
  tmuxName: string;
  abort: AbortController;
  startedAt: number;
  lastActivityAt: number; // last inbound send or claude jsonl output; drives idle stop
  currentChatId?: string;
  jsonlPath: string;
  jsonlOffset: number; // bytes already read from jsonl; -1 = not yet found
}

const JSONL_POLL_MS = 200;
const JSONL_FIND_TIMEOUT_MS = 30000;
// Stop a channel session after this long with no activity (no inbound send and
// no claude output). Frees the claude/bun processes and port; the next send
// recreates the session via --resume (cold-start cost only, no data loss).
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

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

// Single liveness probe of the channel plugin's /health, used by ensure() to
// detect a dead session (claude/plugin crashed) and trigger a relaunch. The
// plugin is a separate process from claude, so it answers instantly even while
// claude is busy. A few retries with a generous timeout ensure a transient
// blip on a healthy plugin is never mistaken for death; a truly dead port
// fails fast (connection refused). Returns true iff the plugin responds OK.
async function probeHealth(port: number): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (r.ok) return true;
    } catch {
      /* not responding */
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// Poll tmux until claude's interactive input prompt is ready. Claude spawns
// the channel plugin quickly (so /health passes) but stays unresponsive to
// MCP notifications while loading a --resume session, so pushing a prompt
// before this returns can be silently lost.
async function waitForClaudeReady(
  tmuxNameArg: string,
  abort: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + CLAUDE_READY_TIMEOUT_MS;
  while (Date.now() < deadline && !abort.aborted) {
    const { stdout } = await sh('tmux', [
      'capture-pane',
      '-t',
      tmuxNameArg,
      '-p',
    ]);
    // A modal (trust / dev-channels / tool permission) renders "❯ 1." options.
    const inDialog =
      /❯\s*\d+\.\s/.test(stdout) || /Do you want to proceed\?/.test(stdout);
    // Ready: an empty interactive prompt line ("❯" with nothing after it).
    // claude pads the prompt with U+00A0 (NBSP), not a plain space, so allow
    // any non-newline whitespace.
    const hasEmptyPrompt = /(^|\n)❯[^\S\r\n]*(\n|$)/.test(stdout);
    if (hasEmptyPrompt && !inDialog) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
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
  // Pass the project's model so channel sessions honor context-window settings
  // like 'claude-opus-4-7[1m]' (1M). Without this, channel falls back to the
  // default model (200k) and large sessions force-compact on resume. Mirrors
  // the -p path (runClaude) validation to guard against shell injection.
  let modelFlag: string | null = null;
  if (s.model) {
    if (!/^[a-zA-Z0-9._\[\]-]+$/.test(s.model)) {
      throw new Error('Invalid model name');
    }
    modelFlag = `--model '${sq(s.model)}'`;
  }
  const parts = [
    `cd '${sq(s.repoPath)}'`,
    'unset CLAUDECODE',
    `export CCCTL_CHANNEL_PORT=${s.port}`,
    // Suppress the "Resume from summary / full session" picker claude shows for
    // sessions over ~70min old or ~100k tokens. Its default ("Resume from
    // summary") silently compacts the session, and our blind startup Enter
    // would confirm it. Raising both thresholds beyond any real session makes
    // resume always load the full session as-is into the [1m] window.
    'export CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999',
    'export CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=999999999',
    [
      `'${sq(config.claudePath)}'`,
      `--mcp-config '${sq(MCP_CONFIG_PATH)}'`,
      `--dangerously-load-development-channels server:ccctl-channel`,
      `--allowedTools 'mcp__ccctl-channel__reply Bash Edit Write Read Glob Grep NotebookEdit WebFetch WebSearch SendMessage Agent TeamCreate TeamDelete ToolSearch'`,
      modelFlag,
      sessionFlag,
    ]
      .filter(Boolean)
      .join(' '),
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
    subtype?: string;
    isCompactSummary?: boolean;
    error?: { message?: string };
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

  // Skip compaction summary entries. On compaction claude appends the summary
  // as a large type:user message with isCompactSummary:true; broadcasting it
  // would dump a multi-KB summary blob into the PWA as if the user typed it.
  if (parsed.isCompactSummary) return;

  // Surface API errors (e.g. 529 overloaded) to the PWA. claude records these
  // as type:"system" subtype:"api_error"; otherwise they're dropped by the
  // guard below and a failed turn looks like a silent stall. The RUNNING
  // watchdog (startIdleSweeper) handles the stuck-state recovery separately.
  if (parsed.type === 'system' && parsed.subtype === 'api_error') {
    const raw = parsed.error?.message ?? 'API error';
    broadcast(s.projectId, {
      type: 'event',
      projectId: s.projectId,
      jobId: s.currentChatId ?? s.sessionId,
      data: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `⚠️ API error: ${raw.slice(0, 200)}` }],
        },
        session_id: s.sessionId,
      },
    });
    // An errored turn never reaches end_turn, so without this the project
    // stays RUNNING forever (perpetual spinner). Mark the job failed and
    // return to IDLE so the PWA recovers. (If claude retries the error and
    // recovers, the resumed output still streams and end_turn re-IDLEs.)
    broadcast(s.projectId, {
      type: 'job_finished',
      projectId: s.projectId,
      jobId: s.currentChatId ?? s.sessionId,
      sessionId: s.sessionId,
      state: 'FAILED',
    });
    projectService.updateProjectState(s.projectId, 'IDLE');
    broadcast(s.projectId, {
      type: 'project_state',
      projectId: s.projectId,
      sessionId: s.sessionId,
      state: 'IDLE',
    });
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
      firstText.startsWith('[Request interrupted') ||
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
  // collapsed tool call. Also flag whether this turn contained a reply so the
  // end-of-turn detection below can treat reply as a user-facing completion
  // marker (end_turn often never arrives after a reply because the harness
  // doesn't always issue the follow-up "Continue from where you left off."
  // turn, leaving the PWA stuck in RUNNING).
  let outMessage = parsed.message;
  let hadReplyToolUse = false;
  if (parsed.type === 'assistant' && Array.isArray(outMessage?.content)) {
    const transformed: ContentBlock[] = [];
    for (const b of outMessage.content as ContentBlock[]) {
      if (b?.type === 'tool_use' && b?.name === REPLY_TOOL_NAME) {
        hadReplyToolUse = true;
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

  // Skip no-op continuation responses ("No response requested." emitted when
  // the harness injects "Continue from where you left off." with nothing to
  // add) — internal noise that would otherwise show as a bot message.
  if (parsed.type === 'assistant' && Array.isArray(outMessage?.content)) {
    const blocks = outMessage.content as ContentBlock[];
    if (
      blocks.every((b) => b?.type === 'text') &&
      blocks.map((b) => b.text ?? '').join('').trim() === 'No response requested.'
    ) {
      return;
    }
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
  // A reply tool_use counts as completion too: the harness frequently never
  // emits a follow-up end_turn turn after a reply, which would otherwise
  // strand the PWA in RUNNING. Re-firing is idempotent if end_turn does
  // arrive later.
  if (
    parsed.type === 'assistant' &&
    (parsed.message?.stop_reason === 'end_turn' || hadReplyToolUse)
  ) {
    broadcast(s.projectId, {
      type: 'job_finished',
      projectId: s.projectId,
      jobId: s.currentChatId ?? s.sessionId,
      sessionId: s.sessionId,
      state: 'SUCCEEDED',
    });
    projectService.updateProjectState(s.projectId, 'IDLE');
    broadcast(s.projectId, {
      type: 'project_state',
      projectId: s.projectId,
      sessionId: s.sessionId,
      state: 'IDLE',
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

  // Decode incrementally so a multibyte UTF-8 char split across a read
  // boundary isn't garbled: the decoder buffers the incomplete trailing bytes
  // and prepends them on the next read. leftover still handles line splits.
  const decoder = new StringDecoder('utf8');
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
      s.lastActivityAt = Date.now(); // claude produced output → not idle
      const chunk = leftover + decoder.write(buf);
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
  model: string | null = null,
): Promise<ChannelSession> {
  const existing = sessions.get(projectId);
  if (existing) {
    // Reuse the running session ONLY if it's the same conversation and still
    // alive. A new conversation (isNew) or a switch to a different session id
    // must NOT inherit the old live session — otherwise "+ New Conversation"
    // silently keeps talking to the previous session. A crashed same-id session
    // (health probe fails) is torn down and relaunched (self-heal).
    if (!isNew && existing.sessionId === sessionId && (await probeHealth(existing.port))) {
      return existing;
    }
    console.log(
      `[channelOrchestrator] not reusing session for ${projectId} ` +
        `(have ${existing.sessionId}, want ${sessionId}, isNew=${isNew}); stopping old`,
    );
    await stop(projectId);
  }

  const port = await pickPort();
  const tname = tmuxName(projectId);

  // Pre-kill any stale tmux session with the same name (graceful, ignore
  // error). Done first so this project's own previous channel claude is gone
  // before the self-session liveness check below.
  await sh('tmux', ['kill-session', '-t', tname]);

  const jsonlPath = jsonlPathFor(repoPath, sessionId);
  let effectiveIsNew = isNew;
  if (!isNew) {
    // (a) Stale claude_session_id whose jsonl is gone → start fresh with the
    // same id, otherwise claude exits with "No conversation found".
    try {
      await stat(jsonlPath);
    } catch {
      effectiveIsNew = true;
      console.warn(
        `[channelOrchestrator] session ${sessionId} has no jsonl; starting fresh with --session-id`,
      );
    }
  }

  if (!effectiveIsNew) {
    // (b) Self-session guard: never --resume a session still live in another
    // claude process (e.g. cc-remote-controller bound to the session driving
    // this controller) — resuming cross-contaminates both conversations. The
    // just-killed pane may linger briefly, so re-check before giving up.
    let livePid = findLiveClaudePid(sessionId);
    for (let i = 0; livePid !== null && i < 6; i++) {
      await new Promise((r) => setTimeout(r, 300));
      livePid = findLiveClaudePid(sessionId);
    }
    if (livePid !== null) {
      throw new Error(
        `session ${sessionId} is already active in another claude process ` +
          `(pid ${livePid}); refusing to resume to avoid cross-contamination. ` +
          `Unlink this project's session or use a project not tied to a live session.`,
      );
    }
  }

  const session: ChannelSession = {
    projectId,
    repoPath,
    sessionId,
    isNew: effectiveIsNew,
    model,
    port,
    tmuxName: tname,
    abort: new AbortController(),
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    jsonlPath,
    jsonlOffset: -1,
  };

  // Regenerate .mcp.generated.json (bun path / plugin dir) before claude reads it.
  writeMcpConfig();

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

  // claude spawns the plugin fast but ignores MCP notifications while it
  // loads a --resume session; wait for its interactive prompt before any
  // sendPrompt so the first push is not lost.
  const ready = await waitForClaudeReady(tname, session.abort.signal);
  if (!ready) {
    console.warn(
      `[channelOrchestrator] claude readiness wait timed out for ${projectId}; proceeding anyway`,
    );
  }

  sessions.set(projectId, session);
  startIdleSweeper();

  // Tail the claude session's jsonl in the background to broadcast
  // assistant/user/tool events to the PWA in real time.
  void watchJsonl(session);

  return session;
}

// Broadcast "job started + RUNNING" immediately on receiving a send, BEFORE
// ensure()'s (possibly slow) session cold-start, so the PWA flips to running
// the instant the user sends instead of waiting for the session to boot. Carries
// sessionId so it lands only on the conversation being started. sendPrompt later
// re-broadcasts the same chatId idempotently once the session is up.
export function announceRunning(
  projectId: string,
  chatId: string,
  sessionId: string,
  prompt: string,
): void {
  broadcast(projectId, {
    type: 'job_started',
    projectId,
    jobId: chatId,
    sessionId,
    prompt,
  });
  projectService.updateProjectState(projectId, 'RUNNING');
  projectService.updateProjectLastJob(projectId, chatId);
  broadcast(projectId, {
    type: 'project_state',
    projectId,
    sessionId,
    state: 'RUNNING',
  });
}

// Roll back the optimistic RUNNING (announceRunning) when the cold-start or
// send fails, so the PWA doesn't get stuck showing running.
export function announceFailed(
  projectId: string,
  chatId: string,
  sessionId: string,
): void {
  broadcast(projectId, {
    type: 'job_finished',
    projectId,
    jobId: chatId,
    sessionId,
    state: 'FAILED',
  });
  projectService.updateProjectState(projectId, 'IDLE');
  broadcast(projectId, {
    type: 'project_state',
    projectId,
    sessionId,
    state: 'IDLE',
  });
}

export async function sendPrompt(
  projectId: string,
  content: string,
  opts?: { chat_id?: string; file_path?: string },
): Promise<{ chat_id: string }> {
  const s = sessions.get(projectId);
  if (!s) throw new Error(`channel orchestrator not running for project ${projectId}`);
  s.lastActivityAt = Date.now(); // inbound send → not idle

  // Notify the PWA that a job is starting; the prompt itself is rendered
  // from job_started.prompt (matching the -p path's flow).
  const userChatId = opts?.chat_id ?? `u${Date.now()}`;
  broadcast(s.projectId, {
    type: 'job_started',
    projectId: s.projectId,
    jobId: userChatId,
    sessionId: s.sessionId,
    prompt: content,
  });
  // Mirror the -p path's project-state lifecycle so the PWA shows "running"
  // and the project sorts to the top of the list (updated_at bump).
  projectService.updateProjectState(s.projectId, 'RUNNING');
  projectService.updateProjectLastJob(s.projectId, userChatId);
  broadcast(s.projectId, {
    type: 'project_state',
    projectId: s.projectId,
    sessionId: s.sessionId,
    state: 'RUNNING',
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
  // Ensure state returns to IDLE even if the turn ended without end_turn.
  // Tag with the stopped session's id so an optimistic RUNNING for a different
  // conversation (announceRunning during a same-project switch) isn't clobbered.
  projectService.updateProjectState(projectId, 'IDLE');
  broadcast(projectId, { type: 'project_state', projectId, sessionId: s.sessionId, state: 'IDLE' });
}

// Interrupt the current turn WITHOUT killing the session (the PWA stop button
// in channel mode). Sends Escape to the interactive claude, which stops
// generation/tool execution and returns to the prompt (recorded as
// "[Request interrupted...]" in the jsonl). The warm session is kept so the
// user can immediately resend a corrected message.
export async function cancel(projectId: string): Promise<void> {
  const s = sessions.get(projectId);
  if (!s) throw new Error(`channel orchestrator not running for project ${projectId}`);
  await sh('tmux', ['send-keys', '-t', s.tmuxName, 'Escape']);
  s.lastActivityAt = Date.now();
  broadcast(projectId, {
    type: 'job_finished',
    projectId,
    jobId: s.currentChatId ?? s.sessionId,
    sessionId: s.sessionId,
    state: 'CANCELED',
  });
  projectService.updateProjectState(projectId, 'IDLE');
  broadcast(projectId, { type: 'project_state', projectId, sessionId: s.sessionId, state: 'IDLE' });
}

export function isRunning(projectId: string): boolean {
  return sessions.has(projectId);
}

// Periodically stop sessions that have seen no activity for IDLE_TIMEOUT_MS.
// Started lazily on first ensure(); idempotent. unref()'d so it never keeps
// the process alive on its own.
let idleSweeper: ReturnType<typeof setInterval> | null = null;
function startIdleSweeper(): void {
  if (idleSweeper) return;
  idleSweeper = setInterval(() => {
    const now = Date.now();
    const stale = [...sessions.values()].filter(
      (s) => now - s.lastActivityAt > IDLE_TIMEOUT_MS,
    );
    for (const s of stale) {
      console.log(
        `[channelOrchestrator] idle ${Math.round(
          (now - s.lastActivityAt) / 60000,
        )}min → stopping ${s.projectId}`,
      );
      void stop(s.projectId);
    }
  }, SWEEP_INTERVAL_MS);
  idleSweeper.unref?.();
}

// Kill all leftover ccctl-* tmux sessions. Call at server startup: after a
// restart the in-memory session map is empty, so any channel session from a
// prior server process is an untracked orphan holding a claude/bun process and
// port. Reaping them frees those resources; the next send to a project
// recreates its session via --resume (no data loss).
export async function reapOrphanSessions(): Promise<void> {
  const r = await sh('tmux', ['ls', '-F', '#{session_name}']);
  if (r.code !== 0) return; // tmux not running or no sessions
  const names = r.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n.startsWith('ccctl-'));
  for (const name of names) {
    await sh('tmux', ['kill-session', '-t', name]);
    console.log(`[channelOrchestrator] reaped orphan tmux session ${name}`);
  }
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
