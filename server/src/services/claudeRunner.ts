import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

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
  let cmd = `cd '${shellEscape(repoPath)}' && claude -p '${escapedPrompt}' --output-format stream-json --verbose --allowedTools 'Bash Edit Write Read Glob Grep NotebookEdit WebFetch WebSearch'`;

  if (claudeSessionId) {
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
