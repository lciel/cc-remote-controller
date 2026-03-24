import { ContextUsage } from '../api/rest';

/** Determine context warning level based on absolute token usage */
export function contextLevel(used: number): 'normal' | 'warning' | 'danger' {
  if (used >= 500000) return 'danger';
  if (used >= 200000) return 'warning';
  return 'normal';
}

interface Props {
  contextUsage?: ContextUsage | null;
  gitBranch?: string | null;
  state?: string;
}

export function ContextBar({ contextUsage, gitBranch, state }: Props) {
  const pct = contextUsage ? Math.min(100, Math.round(contextUsage.used / contextUsage.limit * 100)) : 0;
  const level = contextUsage ? contextLevel(contextUsage.used) : 'normal';

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
          {Math.round(contextUsage.used / 1000)}k/{Math.round(contextUsage.limit / 1000)}k ({pct}%)
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
