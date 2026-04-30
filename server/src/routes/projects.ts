import { Router, Request, Response } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as projectService from '../services/projectService.js';
import * as jobService from '../services/jobService.js';
import { listConversations, readConversation, getContextUsage, getToolResult, discoverClaudeProjects } from '../services/claudeConversations.js';

const router = Router();

import { isValidUUID, isAllowedRepoPath } from '../utils/validation.js';

const MAX_NAME_LENGTH = 255;
const MAX_PROMPT_BYTES = 1 * 1024 * 1024; // 1 MB

// POST /api/projects - Create project
router.post('/', (req: Request, res: Response) => {
  const { name, repoPath, createDir } = req.body;
  if (!name || !repoPath) {
    res.status(400).json({ error: 'name and repoPath are required' });
    return;
  }
  if (typeof name !== 'string' || name.length > MAX_NAME_LENGTH) {
    res.status(400).json({ error: `name must be 1-${MAX_NAME_LENGTH} characters` });
    return;
  }
  if (!path.isAbsolute(repoPath)) {
    res.status(400).json({ error: 'repoPath must be an absolute path' });
    return;
  }
  if (!isAllowedRepoPath(repoPath)) {
    res.status(403).json({ error: 'repoPath is outside allowed directories' });
    return;
  }
  if (!fs.existsSync(repoPath)) {
    if (createDir) {
      fs.mkdirSync(repoPath, { recursive: true });
    } else {
      res.status(400).json({ error: 'repoPath does not exist' });
      return;
    }
  }
  const project = projectService.createProject(name, repoPath);
  res.status(201).json(project);
});

// GET /api/projects/browse - Browse directories
router.get('/browse', (req: Request, res: Response) => {
  const dirPath = typeof req.query.path === 'string' ? req.query.path : '';

  if (!dirPath) {
    // Return allowed base directories
    const env = (process.env.ALLOWED_REPO_BASES || '').trim();
    const bases = env ? env.split(':').map(p => path.resolve(p)) : [os.homedir()];
    res.json({ current: '', dirs: bases.map(b => ({ name: path.basename(b), path: b })) });
    return;
  }

  if (!path.isAbsolute(dirPath)) {
    res.status(400).json({ error: 'path must be absolute' });
    return;
  }
  if (!isAllowedRepoPath(dirPath)) {
    res.status(403).json({ error: 'path is outside allowed directories' });
    return;
  }
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    res.status(400).json({ error: 'path is not a directory' });
    return;
  }

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, path: path.join(dirPath, e.name) }));
    res.json({ current: dirPath, dirs });
  } catch {
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

// GET /api/projects - List projects
router.get('/', (_req: Request, res: Response) => {
  const projects = projectService.listProjects();
  res.json(projects);
});

// GET /api/projects/discover - Discover Claude Code projects from ~/.claude/projects/
router.get('/discover', async (_req: Request, res: Response) => {
  const discovered = await discoverClaudeProjects();
  const existing = projectService.listProjects();
  const existingPaths = new Set(existing.map(p => p.repo_path));
  res.json(discovered.filter(d => !existingPaths.has(d.path)));
});

// DELETE /api/projects/:id - Delete project
router.delete('/:id', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (project.state === 'RUNNING') {
    res.status(409).json({ error: 'Cannot delete a running project' });
    return;
  }
  projectService.deleteProject(project.id);
  res.json({ message: 'Project deleted' });
});

// GET /api/projects/:id - Get project detail
router.get('/:id', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(project);
});

// POST /api/projects/:id/run - Start a job
router.post('/:id/run', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (project.state === 'RUNNING') {
    res.status(409).json({ error: 'Project is already running a job' });
    return;
  }

  const { prompt, images } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    res.status(400).json({ error: 'prompt is required' });
    return;
  }
  if (Buffer.byteLength(prompt, 'utf-8') > MAX_PROMPT_BYTES) {
    res.status(400).json({ error: 'prompt exceeds maximum size (1 MB)' });
    return;
  }

  const jobId = jobService.startJob(project.id, project.repo_path, prompt, images, project.model);
  res.status(201).json({ jobId });
});

// GET /api/projects/:id/jobs - List jobs for a project
router.get('/:id/jobs', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const jobs = jobService.getJobsByProject(project.id);
  res.json(jobs);
});

// GET /api/projects/:id/events - Get all events for the project (all jobs)
router.get('/:id/events', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const events = jobService.getAllEventsByProject(project.id);
  res.json(events);
});

// PATCH /api/projects/:id - Update project (e.g. link Claude session ID)
router.patch('/:id', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const { claudeSessionId, model } = req.body;
  if (claudeSessionId !== undefined) {
    if (claudeSessionId !== null && (typeof claudeSessionId !== 'string' || !isValidUUID(claudeSessionId))) {
      res.status(400).json({ error: 'claudeSessionId must be a valid UUID or null' });
      return;
    }
    projectService.updateClaudeSessionId(project.id, claudeSessionId);
  }
  if (model !== undefined) {
    const ALLOWED_MODELS = ['claude-sonnet-4-6', 'claude-opus-4-7[1m]'];
    if (model !== null && !ALLOWED_MODELS.includes(model)) {
      res.status(400).json({ error: `model must be one of: ${ALLOWED_MODELS.join(', ')}` });
      return;
    }
    projectService.updateModel(project.id, model);
  }

  res.json(projectService.getProject(project.id));
});

// GET /api/projects/:id/conversations - List Claude conversations for this project's repo
router.get('/:id/conversations', async (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const conversations = await listConversations(project.repo_path);
  res.json(conversations);
});

// GET /api/projects/:id/history - Read the linked Claude conversation history
router.get('/:id/history', async (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!project.claude_session_id) {
    res.json([]);
    return;
  }

  const messages = await readConversation(project.repo_path, project.claude_session_id);
  res.json(messages);
});

// GET /api/projects/:id/context - Get context usage for the linked conversation
router.get('/:id/context', async (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!project.claude_session_id) {
    res.json(null);
    return;
  }

  const usage = await getContextUsage(project.repo_path, project.claude_session_id);
  res.json(usage);
});

// GET /api/projects/:id/tool-result/:toolUseId - Get tool result from JSONL
router.get('/:id/tool-result/:toolUseId', async (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!project.claude_session_id) {
    res.json({ result: null });
    return;
  }

  const result = await getToolResult(project.repo_path, project.claude_session_id, req.params.toolUseId);
  res.json({ result });
});

// GET /api/projects/:id/files - List files/directories within project repo
router.get('/:id/files', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  const target = path.resolve(project.repo_path, rel);
  // Reject traversal
  if (target !== project.repo_path && !target.startsWith(project.repo_path + path.sep)) {
    res.status(403).json({ error: 'Path outside project' });
    return;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    res.status(400).json({ error: 'Not a directory' });
    return;
  }
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.gitignore' || e.name === '.env.example')
      .map(e => {
        const full = path.join(target, e.name);
        let size = 0;
        let mtime = 0;
        try {
          const st = fs.statSync(full);
          size = e.isFile() ? st.size : 0;
          mtime = st.mtimeMs;
        } catch { /* ignore */ }
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size,
          mtime,
          path: path.relative(project.repo_path, full),
        };
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({
      current: path.relative(project.repo_path, target),
      items,
    });
  } catch {
    res.status(500).json({ error: 'Failed to read directory' });
  }
});

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB (for text preview)
const MAX_MEDIA_SIZE = 20 * 1024 * 1024; // 20 MB (for raw media streaming)

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
};

function mimeFor(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return (ext && MIME_TYPES[ext]) || 'application/octet-stream';
}

// GET /api/projects/:id/file - Read a file's content
router.get('/:id/file', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  if (!rel) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const target = path.resolve(project.repo_path, rel);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.status(400).json({ error: 'Not a file' });
    return;
  }
  const stat = fs.statSync(target);
  if (stat.size > MAX_FILE_SIZE) {
    res.status(413).json({ error: 'File too large', size: stat.size, limit: MAX_FILE_SIZE });
    return;
  }
  try {
    const buf = fs.readFileSync(target);
    // Detect binary: look for null bytes in first 8KB
    const sample = buf.subarray(0, Math.min(8192, buf.length));
    const isBinary = sample.includes(0);
    if (isBinary) {
      res.json({ path: rel, size: stat.size, binary: true, content: null });
      return;
    }
    res.json({
      path: rel,
      size: stat.size,
      binary: false,
      content: buf.toString('utf-8'),
    });
  } catch {
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// POST /api/projects/:id/files-exist - Check which paths exist as files
router.post('/:id/files-exist', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const paths = Array.isArray(req.body?.paths) ? req.body.paths : null;
  if (!paths) {
    res.status(400).json({ error: 'paths array is required' });
    return;
  }
  const results: Record<string, boolean> = {};
  for (const rel of paths) {
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > 500) {
      results[rel] = false;
      continue;
    }
    try {
      const target = path.resolve(project.repo_path, rel);
      results[rel] = fs.existsSync(target) && fs.statSync(target).isFile();
    } catch {
      results[rel] = false;
    }
  }
  res.json({ results });
});

// GET /api/projects/:id/file-raw - Stream a file's raw bytes with Content-Type
router.get('/:id/file-raw', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  if (!rel) {
    res.status(400).json({ error: 'path is required' });
    return;
  }
  const target = path.resolve(project.repo_path, rel);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    res.status(400).json({ error: 'Not a file' });
    return;
  }
  const stat = fs.statSync(target);
  if (stat.size > MAX_MEDIA_SIZE) {
    res.status(413).json({ error: 'File too large', size: stat.size, limit: MAX_MEDIA_SIZE });
    return;
  }
  const mime = mimeFor(path.basename(target));
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(target).pipe(res);
});

// GET /api/projects/:id/git-branch - Get current git branch
router.get('/:id/git-branch', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  try {
    const headPath = path.join(project.repo_path, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) {
      res.json({ branch: null });
      return;
    }
    const head = fs.readFileSync(headPath, 'utf-8').trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    res.json({ branch: match ? match[1] : null });
  } catch {
    res.json({ branch: null });
  }
});

export default router;
