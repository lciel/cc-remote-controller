import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { getDb } from '../db/index.js';

export interface ClaudeConversation {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  modifiedAt: string;
}

/**
 * Parse context window limit from model string.
 * e.g. "claude-opus-4-6[1m]" → 1000000, "claude-sonnet-4-6" → 200000
 */
function parseContextLimit(model: string): number {
  const match = model.match(/\[(\d+)([km])\]/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    return unit === 'm' ? num * 1000000 : num * 1000;
  }
  if (/claude-opus-4-[67]/.test(model)) return 1000000;
  return 200000;
}

/**
 * Convert a repo path to Claude's project directory name.
 * Claude Code replaces all non-alphanumeric characters with '-'.
 * e.g. /home/lciel/works/git/project_haze → -home-lciel-works-git-project-haze
 */
function repoPathToProjectDir(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Extract the first real user message from a conversation JSONL file.
 */
async function getFirstUserMessage(filePath: string): Promise<{ message: string; timestamp: string } | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' && !parsed.isMeta && parsed.message?.content) {
          const content = typeof parsed.message.content === 'string'
            ? parsed.message.content
            : JSON.stringify(parsed.message.content);
          return {
            message: content.slice(0, 200),
            timestamp: parsed.timestamp || '',
          };
        }
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

/**
 * List Claude Code conversations for a given repo path.
 * Scans ~/.claude/projects/<encoded-path>/ for .jsonl files.
 */
export async function listConversations(repoPath: string): Promise<ClaudeConversation[]> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const projectDirName = repoPathToProjectDir(repoPath);
  const projectDir = path.join(claudeDir, projectDirName);

  if (!fs.existsSync(projectDir)) {
    return [];
  }

  const files = fs.readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      name: f,
      fullPath: path.join(projectDir, f),
      stat: fs.statSync(path.join(projectDir, f)),
    }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const conversations: ClaudeConversation[] = [];

  for (const file of files) {
    const sessionId = file.name.replace('.jsonl', '');
    const firstMsg = await getFirstUserMessage(file.fullPath);

    conversations.push({
      sessionId,
      firstMessage: firstMsg?.message || '(no message)',
      timestamp: firstMsg?.timestamp || file.stat.mtime.toISOString(),
      modifiedAt: file.stat.mtime.toISOString(),
    });
  }

  return conversations;
}

export interface ContextUsage {
  used: number;   // input_tokens + cache_creation + cache_read
  limit: number;  // model context window
  model: string | null;
}

/**
 * Read the last usage data from a Claude JSONL conversation file.
 */
export async function getContextUsage(repoPath: string, sessionId: string): Promise<ContextUsage | null> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const projectDirName = repoPathToProjectDir(repoPath);
  const filePath = path.join(claudeDir, projectDirName, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  // Get context limit from DB system init event (stream-json includes model with context suffix)
  const db = getDb();
  const initRow = db.prepare(`
    SELECT e.payload_json FROM events e
    JOIN jobs j ON e.job_id = j.id
    JOIN projects p ON j.project_id = p.id
    WHERE p.claude_session_id = ? AND e.type = 'system'
      AND e.payload_json LIKE '%"subtype":"init"%'
    ORDER BY e.id DESC LIMIT 1
  `).get(sessionId) as { payload_json: string } | undefined;

  let contextLimit = 200000;
  if (initRow) {
    try {
      const payload = JSON.parse(initRow.payload_json);
      if (payload.model) contextLimit = parseContextLimit(payload.model);
    } catch { /* ignore */ }
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  // Read file in reverse to find the last assistant entry with usage
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      const usage = parsed.message?.usage;
      if (parsed.type === 'assistant' && usage) {
        const used = (usage.input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0);
        const model = (parsed.message?.model as string) || null;
        return { used, limit: contextLimit, model };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export interface DiscoveredProject {
  path: string;
  name: string;
}

/**
 * Extract the cwd field from a JSONL file (typically in the first few lines).
 */
async function extractCwdFromJsonl(filePath: string): Promise<string | null> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch { continue; }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}

/**
 * Discover Claude Code projects by scanning ~/.claude/projects/.
 * Reads cwd from JSONL files to recover the real absolute path.
 */
export async function discoverClaudeProjects(): Promise<DiscoveredProject[]> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  const entries = fs.readdirSync(claudeDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  const results: DiscoveredProject[] = [];

  for (const entry of entries) {
    const projectDir = path.join(claudeDir, entry.name);
    const jsonlFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({
        fullPath: path.join(projectDir, f),
        stat: fs.statSync(path.join(projectDir, f)),
      }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    if (jsonlFiles.length === 0) continue;

    const cwd = await extractCwdFromJsonl(jsonlFiles[0].fullPath);
    if (!cwd || !fs.existsSync(cwd)) continue;

    results.push({ path: cwd, name: path.basename(cwd) });
  }

  return results;
}

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: unknown;
  timestamp: string;
}

/**
 * Read a Claude Code conversation JSONL file and return chat messages.
 */
export async function readConversation(repoPath: string, sessionId: string): Promise<ClaudeMessage[]> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const projectDirName = repoPathToProjectDir(repoPath);
  const filePath = path.join(claudeDir, projectDirName, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) {
    return [];
  }

  const messages: ClaudeMessage[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // Channel mode prompts arrive via mcp notifications, which claude code
        // records with isMeta=true and origin.kind='channel'. Treat those as
        // real user input despite isMeta.
        const isChannelPrompt = parsed.origin?.kind === 'channel';
        if (parsed.type === 'user' && (!parsed.isMeta || isChannelPrompt) && parsed.message?.content) {
          let content = parsed.message.content;
          // Skip tool_result messages (they appear as role:user but are not user input)
          if (Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result') {
            continue;
          }
          // Skip system-generated messages (commands, compact summaries, etc.)
          if (typeof content === 'string') {
            if (
              content.includes('<command-name>') ||
              content.includes('<local-command-stdout>') ||
              content.includes('<local-command-caveat>') ||
              content.includes('<system-reminder>') ||
              content.startsWith('This session is being continued from a previous conversation')
            ) {
              continue;
            }
            // Strip channel-plugin wrapper tags (Channel mode prompts arrive
            // as <channel source="ccctl-channel" chat_id="...">...</channel>).
            const channelMatch = content.match(
              /^<channel\s+source="ccctl-channel"[^>]*>([\s\S]*?)<\/channel>$/,
            );
            if (channelMatch) {
              content = channelMatch[1].trim();
            }
          }
          messages.push({
            role: 'user',
            content,
            timestamp: parsed.timestamp || '',
          });
        } else if (parsed.type === 'assistant' && parsed.message?.content) {
          messages.push({
            role: 'assistant',
            content: parsed.message.content,
            timestamp: parsed.timestamp || '',
          });
        }
      } catch {
        continue;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return messages;
}

/**
 * Find a tool_result by tool_use_id in a Claude JSONL conversation file.
 */
export async function getToolResult(repoPath: string, sessionId: string, toolUseId: string): Promise<string | null> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const projectDirName = repoPathToProjectDir(repoPath);
  const filePath = path.join(claudeDir, projectDirName, `${sessionId}.jsonl`);

  if (!fs.existsSync(filePath)) return null;

  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.includes(toolUseId)) continue;
      try {
        const parsed = JSON.parse(line);
        const content = parsed.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id === toolUseId) {
            let result: string;
            if (typeof block.content === 'string') {
              result = block.content;
            } else if (Array.isArray(block.content)) {
              // Prefer extracting text from structured blocks (e.g. Agent results)
              // so the client gets plain markdown instead of a JSON wrapper.
              const texts: string[] = [];
              for (const part of block.content) {
                if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
                  texts.push(part.text);
                }
              }
              result = texts.length > 0 ? texts.join('\n\n') : JSON.stringify(block.content, null, 2);
            } else {
              result = JSON.stringify(block.content, null, 2);
            }
            return result;
          }
        }
      } catch { continue; }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return null;
}
