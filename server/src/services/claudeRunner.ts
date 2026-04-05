import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config.js';
import { isValidUUID } from '../utils/validation.js';

/**
 * Characters that are dangerous in shell contexts.
 * Even with shellEscape(), passing user input through `bash -lc` is risky.
 * Reject paths containing shell metacharacters as an extra safety layer.
 */
const SHELL_META_RE = /[;&|`$(){}!<>\\"\n\r\x00]/;

/**
 * Validate that repoPath is an absolute path, exists, and contains no
 * shell metacharacters (defense-in-depth against injection).
 */
function validateRepoPath(repoPath: string): void {
  if (!path.isAbsolute(repoPath)) {
    throw new Error(`repoPath must be absolute: ${repoPath}`);
  }
  if (SHELL_META_RE.test(repoPath)) {
    throw new Error('repoPath contains disallowed characters');
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
  model?: string | null;
}

/**
 * Spawn a Claude process with stream-json output.
 * If claudeSessionId is provided, uses --resume to continue the conversation.
 */
export function runClaude(options: ClaudeRunOptions): ChildProcess {
  const { repoPath, prompt, claudeSessionId, model } = options;
  validateRepoPath(repoPath);

  const escapedPrompt = shellEscape(prompt);
  const claudeBin = shellEscape(config.claudePath);
  let cmd = `cd '${shellEscape(repoPath)}' && '${claudeBin}' --output-format stream-json --verbose --allowedTools 'Bash Edit Write Read Glob Grep NotebookEdit WebFetch WebSearch SendMessage Agent TeamCreate TeamDelete ToolSearch'`;

  if (model) {
    // Validate model value is alphanumeric with hyphens/dots/brackets only (no injection)
    if (!/^[a-zA-Z0-9._\[\]-]+$/.test(model)) {
      throw new Error('Invalid model name');
    }
    cmd += ` --model '${shellEscape(model)}'`;
  }

  if (claudeSessionId) {
    if (!isValidUUID(claudeSessionId)) {
      throw new Error('Invalid claudeSessionId format');
    }
    cmd += ` --resume '${shellEscape(claudeSessionId)}'`;
  }

  // Prepend newline to prevent prompt starting with '-' being parsed as a CLI option
  const safePrompt = prompt.startsWith('-') ? `\n${escapedPrompt}` : escapedPrompt;
  cmd += ` -p '${safePrompt}'`;

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
