import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that a Claude session ID is a valid UUID.
 */
function validateSessionId(sessionId: string): void {
  if (!UUID_RE.test(sessionId)) {
    throw new Error('Invalid claudeSessionId format');
  }
}

/**
 * Validate that repoPath is an absolute path and exists.
 */
function validateRepoPath(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new Error(`repoPath must be absolute: ${repoPath}`);
  }
  if (!fs.existsSync(repoPath)) {
    throw new Error(`repoPath does not exist: ${repoPath}`);
  }
}

/**
 * Escape single quotes in a string for use in a shell single-quoted context.
 * 'foo'bar' → 'foo'\''bar'
 */
function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

export interface ClaudeRunOptions {
  repoPath: string;
  prompt: string;
  claudeSessionId?: string | null;
}

/**
 * Spawn a Claude process with stream-json output.
 * If claudeSessionId is provided, uses --resume to continue the conversation.
 */
export function runClaude(options: ClaudeRunOptions): ChildProcess {
  const { repoPath, prompt, claudeSessionId } = options;
  validateRepoPath(repoPath);

  const escapedPrompt = shellEscape(prompt);
  const claudeBin = shellEscape(config.claudePath);
  let cmd = `cd '${shellEscape(repoPath)}' && '${claudeBin}' -p '${escapedPrompt}' --output-format stream-json --verbose --allowedTools 'Bash Edit Write Read Glob Grep NotebookEdit WebFetch WebSearch'`;

  if (claudeSessionId) {
    validateSessionId(claudeSessionId);
    cmd += ` --resume '${shellEscape(claudeSessionId)}'`;
  }

  // Remove CLAUDECODE env var to avoid nested session detection
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const shell = process.env.SHELL || 'bash';
  const child = spawn(shell, ['-lc', cmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env,
  });

  return child;
}
