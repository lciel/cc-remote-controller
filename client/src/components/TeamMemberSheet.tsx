import { useState, useMemo, useRef, useEffect } from 'preact/hooks';
import { api, TeamSnapshot, TeamMember, TeamInboxMessage } from '../api/rest';
import { BottomSheet } from './BottomSheet';

interface Props {
  projectId: string;
  team: TeamSnapshot;
  member: TeamMember;
  onClose: () => void;
}

interface Conversation {
  timestamp: string;
  direction: 'in' | 'out';
  text: string;
  summary?: string;
}

function buildConversation(team: TeamSnapshot, memberName: string): Conversation[] {
  const out: Conversation[] = [];
  for (const m of team.inboxes[memberName] || []) {
    if (m.from === 'team-lead') {
      out.push({ timestamp: m.timestamp, direction: 'out', text: m.text, summary: m.summary });
    }
  }
  for (const m of team.inboxes['team-lead'] || []) {
    if (m.from === memberName) {
      out.push({ timestamp: m.timestamp, direction: 'in', text: m.text, summary: m.summary });
    }
  }
  out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return out;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString();
  } catch {
    return iso;
  }
}

function summarizeText(text: string): { text: string; system: string | null } {
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.type === 'string') {
        if (obj.type === 'idle_notification') return { text: '', system: 'idle' };
        return { text: '', system: obj.type.replace(/_/g, ' ') };
      }
    } catch { /* fall through */ }
  }
  return { text: trimmed, system: null };
}

export function TeamMemberSheet({ projectId, team, member, onClose }: Props) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conversation = useMemo(() => buildConversation(team, member.name), [team, member.name]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Sheet-body owns the scroll now, so scrollIntoView the log's bottom
    // edge to bring the newest message into view.
    if (listRef.current) listRef.current.scrollIntoView({ block: 'end' });
  }, [conversation.length]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.sendTeammateMessage(projectId, member.name, { text });
      setDraft('');
    } catch (e) {
      setError((e as Error).message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const colorClass = `team-color-${member.color || 'gray'}`;

  // Composer is rendered as the BottomSheet footer so it stays pinned
  // and the sheet-body handles all scrolling — keeps drag-to-close from
  // misfiring when the conversation log itself isn't scrolled to top.
  const composer = (
    <div class="team-member-sheet-composer">
      <textarea
        class="team-member-sheet-input"
        placeholder={`@${member.name} へ直接メッセージ…`}
        value={draft}
        onInput={(e) => setDraft((e.currentTarget as HTMLTextAreaElement).value)}
        disabled={sending}
        rows={3}
      />
      {error && <div class="team-member-sheet-error">{error}</div>}
      <button
        class="btn btn-primary team-member-sheet-send"
        onClick={handleSend}
        disabled={sending || !draft.trim()}
      >
        {sending ? '送信中…' : '送信'}
      </button>
    </div>
  );

  return (
    <BottomSheet title={`@${member.name}`} onClose={onClose} footer={composer}>
      <div class={`team-member-sheet ${colorClass}`}>
        <div class="team-member-sheet-meta">
          <span class="team-member-sheet-role">{member.agentType || 'member'}</span>
          {member.model && <span class="team-member-sheet-model">{member.model}</span>}
        </div>

        <div class="team-member-sheet-log" ref={listRef}>
          {conversation.length === 0 ? (
            <div class="team-member-sheet-empty">まだやり取りがありません。</div>
          ) : (
            conversation.map((c, i) => {
              const { text, system } = summarizeText(c.text);
              return (
                <div
                  key={i}
                  class={`team-member-sheet-msg team-member-sheet-msg-${c.direction}`}
                >
                  <div class="team-member-sheet-msg-time">{formatTime(c.timestamp)}</div>
                  {system ? (
                    <div class="team-member-sheet-msg-system">— {system} —</div>
                  ) : (
                    <div class="team-member-sheet-msg-body">{text}</div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </BottomSheet>
  );
}
