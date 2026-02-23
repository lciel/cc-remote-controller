import express from 'express';
import path from 'path';
import { authMiddleware } from './middleware/auth.js';
import projectsRouter from './routes/projects.js';
import jobsRouter from './routes/jobs.js';

const app = express();

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:");
  next();
});

app.use(express.json({ limit: '10mb' }));

// Serve static files from client build (production)
app.use(express.static(path.resolve(import.meta.dirname, '../../client/dist')));

// API routes with auth
app.use('/api/projects', authMiddleware, projectsRouter);
app.use('/api/jobs', authMiddleware, jobsRouter);

// SPA fallback - serve index.html for non-API routes
app.get('*', (_req, res) => {
  const indexPath = path.resolve(import.meta.dirname, '../../client/dist/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Not found' });
    }
  });
});

export default app;
