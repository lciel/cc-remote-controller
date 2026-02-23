import { ContextUsage } from '../api/rest';

interface Props {
  contextUsage: ContextUsage;
}

export function ContextBar({ contextUsage }: Props) {
  const pct = Math.min(100, Math.round(contextUsage.used / contextUsage.limit * 100));
  const level = pct >= 80 ? 'danger' : pct >= 60 ? 'warning' : 'normal';

  return (
    <div class={`context-bar context-${level}`}>
      {contextUsage.model && (
        <>
          <span class="context-model">
            {contextUsage.model.replace('claude-', '')}
          </span>
          <span class="context-sep">|</span>
        </>
      )}
      <span class="context-meter">
        <span class="context-bar-bg">
          <span class="context-bar-fill" style={{ width: `${pct}%` }} />
        </span>
        {Math.round(contextUsage.used / 1000)}k/{Math.round(contextUsage.limit / 1000)}k ({pct}%)
      </span>
    </div>
  );
}
