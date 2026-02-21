import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';

export interface ClaudeConversation {
  sessionId: string;
  firstMessage: string;
  timestamp: string;
  modifiedAt: string;
}

/**
 * Convert a repo path to Claude's project directory name.
 * Claude Code uses the absolute path with '/' replaced by '-' and leading '-'.
 * e.g. /home/lciel/works/git/project → -home-lciel-works-git-project
 */
function repoPathToProjectDir(repoPath: string): string {
  return repoPath.replace(/\//g, '-');
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

  // Read file in reverse to find the last assistant entry with usage
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      const usage = parsed.message?.usage;
      if (parsed.type === 'assistant' && usage) {
        const used = (usage.input_tokens || 0)
          + (usage.cache_creation_input_tokens || 0)
          + (usage.cache_read_input_tokens || 0);
        const model = (parsed.message?.model as string) || null;
        return { used, limit: 200000, model };
      }
    } catch {
      continue;
    }
  }
  return null;
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
        if (parsed.type === 'user' && !parsed.isMeta && parsed.message?.content) {
          const content = parsed.message.content;
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
