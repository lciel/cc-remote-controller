import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import * as projectService from '../services/projectService.js';
import * as jobService from '../services/jobService.js';
import { listConversations, readConversation, getContextUsage, getToolResult, discoverClaudeProjects } from '../services/claudeConversations.js';

const router = Router();

import { isValidUUID } from '../utils/validation.js';

const MAX_NAME_LENGTH = 255;
const MAX_PROMPT_BYTES = 1 * 1024 * 1024; // 1 MB

// POST /api/projects - Create project
router.post('/', (req: Request, res: Response) => {
  const { name, repoPath } = req.body;
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
  if (!fs.existsSync(repoPath)) {
    res.status(400).json({ error: 'repoPath does not exist' });
    return;
  }
  const project = projectService.createProject(name, repoPath);
  res.status(201).json(project);
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

  const jobId = jobService.startJob(project.id, project.repo_path, prompt, images);
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

  const { claudeSessionId } = req.body;
  if (claudeSessionId !== undefined) {
    if (claudeSessionId !== null && (typeof claudeSessionId !== 'string' || !isValidUUID(claudeSessionId))) {
      res.status(400).json({ error: 'claudeSessionId must be a valid UUID or null' });
      return;
    }
    projectService.updateClaudeSessionId(project.id, claudeSessionId);
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
