import { useState, useEffect } from 'preact/hooks';
import { api, AnalysisStatus } from '../api/rest';
import { useGlobalWsMessage } from '../hooks/useWebSocket';

interface Props {
  path?: string;
}

export function AnalyticsView({}: Props) {
  const [analyses, setAnalyses] = useState<AnalysisStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningAll, setRunningAll] = useState(false);

  const refresh = () => {
    api.getAnalyses().then(setAnalyses).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  useGlobalWsMessage((data: unknown) => {
    const msg = data as { type?: string; projectId?: string };
    if (msg.type === 'analysis_done') {
      refresh();
    }
  });

  const handleAnalyzeAll = async () => {
    setRunningAll(true);
    try {
      await api.runAllAnalyses();
      refresh();
    } catch { /* ignore */ }
  };

  const handleAnalyzeOne = async (projectId: string) => {
    setAnalyses(prev => prev.map(a =>
      a.projectId === projectId ? { ...a, state: 'running' as const } : a
    ));
    try {
      await api.runAnalysis(projectId);
    } catch { /* ignore */ }
  };

  const allDone = analyses.every(a => a.state !== 'running');
  useEffect(() => {
    if (allDone && runningAll) setRunningAll(false);
  }, [allDone, runningAll]);

  const anyRunning = analyses.some(a => a.state === 'running');

  return (
    <div class="page">
      <header class="header">
        <h1>
          <a href="/" style={{ color: 'inherit', textDecoration: 'none' }}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style={{ verticalAlign: '-3px', marginRight: '8px' }}>
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </a>
          Analytics
        </h1>
        <button
          class="btn btn-primary btn-sm"
          onClick={handleAnalyzeAll}
          disabled={anyRunning}
        >
          {anyRunning ? 'Analyzing...' : 'Analyze All'}
        </button>
      </header>

      {loading ? (
        <div class="loading">Loading...</div>
      ) : analyses.length === 0 ? (
        <div class="empty">No projects found.</div>
      ) : (
        <div class="analytics-list">
          {analyses.map((a) => (
            <div key={a.projectId} class="card analytics-card">
              <div class="analytics-card-header">
                <div>
                  <div class="analytics-project-name">{a.projectName}</div>
                  <div class="analytics-repo-path">{a.repoPath}</div>
                </div>
                {a.state === 'running' ? (
                  <div class="analytics-spinner" />
                ) : (
                  <button
                    class={`btn btn-sm ${a.state === 'idle' || a.stale ? 'btn-primary' : ''}`}
                    onClick={() => handleAnalyzeOne(a.projectId)}
                  >
                    {a.state === 'idle' ? 'Analyze' : a.stale ? 'Update' : 'Re-run'}
                  </button>
                )}
              </div>
              {a.state === 'running' && (
                <div class="analytics-summary analytics-running">Analyzing...</div>
              )}
              {a.state === 'done' && a.summary && (
                <div class="analytics-summary">
                  {a.stale && <span class="analytics-stale-badge">outdated</span>}
                  <AnalysisSections summary={a.summary} />
                  {a.analyzed_at && (
                    <div class="analytics-timestamp">{formatTime(a.analyzed_at)}</div>
                  )}
                </div>
              )}
              {a.state === 'idle' && (
                <div class="analytics-summary analytics-idle">Not analyzed yet</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ParsedSections {
  overview: string;
  status: string;
  issues: string;
  raw?: string;
}

function parseSections(text: string): ParsedSections {
  const lines = text.split('\n');
  let overview = '';
  let status = '';
  let issues = '';
  let current: 'none' | 'overview' | 'status' | 'issues' = 'none';

  for (const line of lines) {
    const trimmed = line.trim();
    const overviewMatch = trimmed.match(/^(?:\*\*)?概要(?:\*\*)?[:：]\s*(.*)/);
    const statusMatch = trimmed.match(/^(?:\*\*)?状態(?:\*\*)?[:：]\s*(.*)/);
    const issuesMatch = trimmed.match(/^(?:\*\*)?課題(?:\*\*)?[:：]\s*(.*)/);

    if (overviewMatch) {
      current = 'overview';
      overview = overviewMatch[1];
    } else if (statusMatch) {
      current = 'status';
      status = statusMatch[1];
    } else if (issuesMatch) {
      current = 'issues';
      issues = issuesMatch[1];
    } else if (trimmed && current !== 'none') {
      const target = current === 'overview' ? overview : current === 'status' ? status : issues;
      const appended = target ? target + '\n' + trimmed : trimmed;
      if (current === 'overview') overview = appended;
      else if (current === 'status') status = appended;
      else issues = appended;
    }
  }

  if (!overview && !status && !issues) {
    return { overview: '', status: '', issues: '', raw: text };
  }
  return { overview, status, issues };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function AnalysisSections({ summary }: { summary: string }) {
  const s = parseSections(summary);

  if (s.raw) {
    const html = escapeHtml(s.raw)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    return <div class="analytics-summary-text" dangerouslySetInnerHTML={{ __html: html }} />;
  }

  return (
    <div class="analytics-sections">
      {s.overview && (
        <div class="analytics-section">
          <div class="analytics-section-label">概要</div>
          <div class="analytics-section-body">{s.overview}</div>
        </div>
      )}
      {s.status && (
        <div class="analytics-section">
          <div class="analytics-section-label">状態</div>
          <div class="analytics-section-body">{s.status}</div>
        </div>
      )}
      {s.issues && (
        <div class="analytics-section">
          <div class="analytics-section-label">課題</div>
          <div class="analytics-section-body">{s.issues}</div>
        </div>
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso + (iso.endsWith('Z') ? '' : 'Z'));
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    const diffD = Math.floor(diffH / 24);
    return `${diffD}d ago`;
  } catch {
    return iso;
  }
}
