import { Router, Request, Response } from 'express';
import * as projectService from '../services/projectService.js';
import * as analysisService from '../services/analysisService.js';
import { broadcastAll } from '../ws/handler.js';

const router = Router();

// GET /api/analyses - Get all analyses with status
router.get('/', (_req: Request, res: Response) => {
  const projects = projectService.listProjects();
  const statuses = projects.map(p => ({
    ...analysisService.getStatus(p.id),
    projectName: p.name,
    repoPath: p.repo_path,
  }));
  res.json(statuses);
});

// POST /api/analyses/:projectId/run - Run analysis for a single project
router.post('/:projectId/run', (req: Request, res: Response) => {
  const project = projectService.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (analysisService.isRunning(project.id)) {
    res.status(409).json({ error: 'Analysis already running' });
    return;
  }

  analysisService.runAnalysis(project.id, () => {
    const status = analysisService.getStatus(project.id);
    broadcastAll({ type: 'analysis_done', ...status, projectName: project.name } as any);
  });

  res.json({ status: 'started' });
});

// POST /api/analyses/run-all - Run analysis for all projects (skip fresh cache)
router.post('/run-all', (_req: Request, res: Response) => {
  const projects = projectService.listProjects();
  const toAnalyze = projects.filter(p => {
    const status = analysisService.getStatus(p.id);
    return status.state !== 'running' && (status.state === 'idle' || status.stale);
  });

  if (toAnalyze.length === 0) {
    res.json({ status: 'nothing_to_analyze', count: 0 });
    return;
  }

  // Run sequentially to avoid overloading
  let idx = 0;
  const runNext = () => {
    if (idx >= toAnalyze.length) return;
    const p = toAnalyze[idx++];
    analysisService.runAnalysis(p.id, () => {
      const status = analysisService.getStatus(p.id);
      broadcastAll({ type: 'analysis_done', ...status, projectName: p.name } as any);
      runNext();
    });
  };
  runNext();

  res.json({ status: 'started', count: toAnalyze.length });
});

export default router;
