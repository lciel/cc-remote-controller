import { ContextUsage } from '../api/rest';

/** Determine context warning level based on token usage ratio */
export function contextLevel(used: number, limit: number): 'normal' | 'warning' | 'danger' {
  const pct = used / limit;
  if (limit >= 500000) {
    // 1M context: warn at 20% (200k), danger at 50% (500k)
    if (pct >= 0.5) return 'danger';
    if (pct >= 0.2) return 'warning';
  } else {
    // 200k context: warn at 55%, danger at 75%
    if (pct >= 0.75) return 'danger';
    if (pct >= 0.55) return 'warning';
  }
  return 'normal';
}

interface Props {
  contextUsage?: ContextUsage | null;
  gitBranch?: string | null;
  state?: string;
}

export function ContextBar({ contextUsage, gitBranch, state }: Props) {
  const pct = contextUsage ? Math.min(100, Math.round(contextUsage.used / contextUsage.limit * 100)) : 0;
  const level = contextUsage ? contextLevel(contextUsage.used, contextUsage.limit) : 'normal';

  return (
    <div class={`context-bar context-${level}`}>
      {contextUsage?.model && (
        <>
          <span class="context-model">
            {contextUsage.model.replace('claude-', '')}
          </span>
          <span class="context-sep">|</span>
        </>
      )}
      {contextUsage && (
        <span class="context-meter">
          <span class="context-bar-bg">
            <span class="context-bar-fill" style={{ width: `${pct}%` }} />
          </span>
          {Math.round(contextUsage.used / 1000)}k ({pct}%)
        </span>
      )}
      {gitBranch && (
        <>
          {contextUsage && <span class="context-sep">|</span>}
          <span class="context-git">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            {gitBranch}
          </span>
        </>
      )}
    </div>
  );
}
