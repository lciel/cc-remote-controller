import { Router, Request, Response } from 'express';
import * as jobService from '../services/jobService.js';

const router = Router();

// POST /api/jobs/:jobId/cancel - Cancel a job
router.post('/:jobId/cancel', (req: Request, res: Response) => {
  const { jobId } = req.params;
  const success = jobService.cancelJob(jobId);
  if (!success) {
    res.status(404).json({ error: 'Job not found or not running' });
    return;
  }
  res.json({ message: 'Cancel requested' });
});

export default router;
