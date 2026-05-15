import { useState, useRef, useEffect } from 'preact/hooks';
import { TeamSnapshot, TeamMember, TeamInboxMessage } from '../api/rest';

interface Props {
  team: TeamSnapshot | null;
  loading?: boolean;
  onMemberClick?: (member: TeamMember) => void;
  variant: 'sidebar' | 'floating';
}

function statusForMember(team: TeamSnapshot, member: TeamMember): 'active' | 'idle' | 'unknown' {
  // Find the latest message FROM this member by scanning all inboxes
  let latest: TeamInboxMessage | null = null;
  for (const owner of Object.keys(team.inboxes)) {
    for (const m of team.inboxes[owner] || []) {
      if (m.from === member.name) {
        if (!latest || m.timestamp > latest.timestamp) latest = m;
      }
    }
  }
  if (!latest) return 'unknown';
  try {
    const t = (latest.text || '').trim();
    if (t.startsWith('{')) {
      const obj = JSON.parse(t);
      if (obj?.type === 'idle_notification') return 'idle';
    }
  } catch { /* not JSON */ }
  return 'active';
}

export function TeamPanel({ team, onMemberClick, variant }: Props) {
  // sidebar = always open; floating = collapsible, default collapsed
  const [expanded, setExpanded] = useState(variant === 'sidebar');
  const containerRef = useRef<HTMLDivElement>(null);

  // floating only: dismiss on outside tap. Defer registration one tick so
  // the same pointerdown that opened the panel doesn't immediately close it.
  useEffect(() => {
    if (variant !== 'floating' || !expanded) return;
    let attached = false;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) {
        setExpanded(false);
      }
    };
    const id = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
      attached = true;
    }, 0);
    return () => {
      window.clearTimeout(id);
      if (attached) document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [variant, expanded]);

  // Render nothing until a live team exists. team_mode ON without an active
  // team (or an empty team) keeps the UI clean.
  if (!team || team.members.length === 0) return null;

  const memberRows = team.members.map((m) => ({
    member: m,
    status: statusForMember(team, m),
  }));

  // Body is always rendered so the floating variant can animate max-height
  // open/close. CSS hides it when collapsed in the floating variant.
  const isExpanded = variant === 'sidebar' || expanded;

  return (
    <div
      ref={containerRef}
      class={`team-panel team-panel-${variant}${isExpanded ? ' team-panel-expanded' : ''}`}
    >
      {variant === 'sidebar' && (
        <div class="team-panel-label">Team: {team.teamName}</div>
      )}
      {variant === 'floating' && (
        <button
          type="button"
          class="team-panel-header team-panel-header-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <svg
            class="team-panel-icon"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span class="team-panel-title">{team.teamName}</span>
          <span class="team-panel-meta">({team.members.length})</span>
          <svg
            class={`team-panel-chevron${expanded ? ' open' : ''}`}
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      <div class="team-panel-body">
        <ul class="team-member-list">
          {memberRows.map(({ member, status }) => (
            <li
              key={member.agentId}
              class={`team-member team-color-${member.color || 'gray'}${onMemberClick ? ' team-member-clickable' : ''}`}
              role={onMemberClick ? 'button' : undefined}
              tabIndex={onMemberClick ? 0 : undefined}
              onClick={onMemberClick ? () => onMemberClick(member) : undefined}
              onKeyDown={onMemberClick ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onMemberClick(member); }
              } : undefined}
            >
              <span class={`team-member-dot team-member-dot-${status}`} />
              <span class="team-member-name">{member.name}</span>
              <span class="team-member-role">{member.agentType || ''}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
