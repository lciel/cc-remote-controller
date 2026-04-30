import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import * as projectService from './projectService.js';
import { listConversations, readConversation } from './claudeConversations.js';

const ANALYZE_DIR = '/tmp/ccctl-analyze';

export interface ProjectAnalysis {
  project_id: string;
  summary: string;
  analyzed_at: string;
  change_hash: string;
}

interface AnalysisStatus {
  projectId: string;
  state: 'idle' | 'running' | 'done' | 'error';
  summary?: string;
  analyzed_at?: string;
  stale?: boolean;
}

const runningAnalyses = new Map<string, boolean>();

export function getAnalysis(projectId: string): ProjectAnalysis | null {
  const db = getDb();
  return (db.prepare('SELECT * FROM project_analyses WHERE project_id = ?').get(projectId) as ProjectAnalysis) || null;
}

export function getAllAnalyses(): ProjectAnalysis[] {
  const db = getDb();
  return db.prepare('SELECT * FROM project_analyses').all() as ProjectAnalysis[];
}

function saveAnalysis(projectId: string, summary: string, changeHash: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO project_analyses (project_id, summary, analyzed_at, change_hash)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET summary = ?, analyzed_at = ?, change_hash = ?`
  ).run(projectId, summary, new Date().toISOString(), changeHash,
        summary, new Date().toISOString(), changeHash);
}

function computeChangeHash(repoPath: string): string {
  const hash = crypto.createHash('md5');

  // Git HEAD
  const headPath = path.join(repoPath, '.git', 'HEAD');
  if (fs.existsSync(headPath)) {
    hash.update(fs.readFileSync(headPath, 'utf-8'));
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    const refMatch = head.match(/^ref: (.+)$/);
    if (refMatch) {
      const refPath = path.join(repoPath, '.git', refMatch[1]);
      if (fs.existsSync(refPath)) {
        hash.update(fs.readFileSync(refPath, 'utf-8'));
      }
    }
  }

  // Conversation JSONL modification times
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const projectDirName = repoPath.replace(/[^a-zA-Z0-9]/g, '-');
  const convDir = path.join(claudeDir, projectDirName);
  if (fs.existsSync(convDir)) {
    const files = fs.readdirSync(convDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files.slice(0, 5)) {
      const stat = fs.statSync(path.join(convDir, f));
      hash.update(`${f}:${stat.mtimeMs}`);
    }
  }

  return hash.digest('hex');
}

async function gatherProjectContext(projectId: string): Promise<string> {
  const project = projectService.getProject(projectId);
  if (!project) throw new Error('Project not found');

  const parts: string[] = [];
  parts.push(`# Project: ${project.name}`);
  parts.push(`Repo: ${project.repo_path}`);
  parts.push(`State: ${project.state}`);
  parts.push('');

  // Git log
  try {
    const gitLog = await runCommand('git', ['log', '--oneline', '-20'], project.repo_path);
    if (gitLog.trim()) {
      parts.push('## Recent Git Commits');
      parts.push(gitLog.trim());
      parts.push('');
    }
  } catch { /* no git */ }

  // Git status
  try {
    const gitStatus = await runCommand('git', ['status', '--short'], project.repo_path);
    if (gitStatus.trim()) {
      parts.push('## Uncommitted Changes');
      parts.push(gitStatus.trim());
      parts.push('');
    }
  } catch { /* no git */ }

  // Recent conversation messages
  const conversations = await listConversations(project.repo_path);
  if (conversations.length > 0) {
    const latest = conversations[0];
    const messages = await readConversation(project.repo_path, latest.sessionId);
    const recentMessages = messages.slice(-20);
    if (recentMessages.length > 0) {
      parts.push('## Recent Conversation (latest session)');
      for (const msg of recentMessages) {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = (msg.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text!)
            .join('\n');
        }
        if (text) {
          const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
          parts.push(`[${role}] ${truncated}`);
        }
      }
      parts.push('');
    }
  }

  return parts.join('\n');
}

function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with ${code}`));
    });
    child.on('error', reject);
  });
}

function shellEscape(str: string): string {
  return str.replace(/'/g, "'\\''");
}

export function isRunning(projectId: string): boolean {
  return runningAnalyses.get(projectId) === true;
}

export function getStatus(projectId: string): AnalysisStatus {
  const analysis = getAnalysis(projectId);
  const project = projectService.getProject(projectId);
  if (!project) return { projectId, state: 'idle' };

  if (isRunning(projectId)) {
    return { projectId, state: 'running' };
  }

  if (!analysis) {
    return { projectId, state: 'idle' };
  }

  const currentHash = computeChangeHash(project.repo_path);
  return {
    projectId,
    state: 'done',
    summary: analysis.summary,
    analyzed_at: analysis.analyzed_at,
    stale: currentHash !== analysis.change_hash,
  };
}

export async function runAnalysis(projectId: string, onDone?: () => void): Promise<void> {
  if (isRunning(projectId)) return;

  const project = projectService.getProject(projectId);
  if (!project) throw new Error('Project not found');

  runningAnalyses.set(projectId, true);

  try {
    const context = await gatherProjectContext(projectId);

    if (!fs.existsSync(ANALYZE_DIR)) {
      fs.mkdirSync(ANALYZE_DIR, { recursive: true });
    }

    const prompt = `以下のプロジェクト情報を元に、このプロジェクトの現在の状況を日本語で簡潔に報告してください。

必ず以下の形式で出力してください。各項目は1〜2行で簡潔に。

概要: このプロジェクトが何であるか
状態: 直近で何が行われ、今どういう状態か
課題: 未解決の問題、ブロッカー、次にやるべきこと（なければ「特になし」）

例:
概要: React製のダッシュボードアプリ
状態: ユーザー認証機能を実装中。ログイン画面はできたがトークンリフレッシュが未実装
課題: リフレッシュトークンの保存先（cookie vs localStorage）を決める必要がある

---
${context}`;

    const result = await runClaudeForAnalysis(prompt);
    const changeHash = computeChangeHash(project.repo_path);
    saveAnalysis(projectId, result, changeHash);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    saveAnalysis(projectId, `Analysis failed: ${msg}`, '');
  } finally {
    runningAnalyses.delete(projectId);
    onDone?.();
  }
}

function runClaudeForAnalysis(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(ANALYZE_DIR)) {
      fs.mkdirSync(ANALYZE_DIR, { recursive: true });
    }

    const escapedPrompt = shellEscape(prompt);
    const claudeBin = shellEscape(config.claudePath);
    const safePrompt = prompt.startsWith('-') ? `\n${escapedPrompt}` : escapedPrompt;
    const cmd = `cd '${shellEscape(ANALYZE_DIR)}' && '${claudeBin}' --output-format stream-json --verbose -p '${safePrompt}'`;

    const env = { ...process.env };
    delete env.CLAUDECODE;

    const shell = process.env.SHELL || 'bash';
    const child = spawn(shell, ['-lc', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env,
    });

    let resultText = '';
    let buffer = '';

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'assistant' && parsed.message?.content) {
            for (const block of parsed.message.content) {
              if (block.type === 'text' && block.text) {
                resultText = block.text;
              }
            }
          }
        } catch { /* skip non-JSON */ }
      }
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Analysis timed out'));
    }, 120000);

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (resultText) {
        resolve(resultText);
      } else {
        reject(new Error(`Claude exited with code ${code}, no output`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
