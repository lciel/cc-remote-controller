import { useState, useEffect } from 'preact/hooks';
import { api, ClaudeConversation } from '../api/rest';

interface Props {
  projectId: string;
  currentSessionId: string | null;
  isOpen: boolean;
  onClose: () => void;
  onSelect: (sessionId: string) => Promise<void>;
}

export function ConversationSwitcher({ projectId, currentSessionId, isOpen, onClose, onSelect }: Props) {
  const [conversations, setConversations] = useState<ClaudeConversation[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    api.getClaudeConversations(projectId)
      .then(setConversations)
      .catch(() => setConversations([]))
      .finally(() => setLoading(false));
  }, [isOpen, projectId]);

  if (!isOpen) return null;

  return (
    <div class="modal-overlay" onClick={onClose}>
      <div class="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <div class="label">Claude Code Sessions</div>
          <button class="btn-icon modal-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <button
          class="conv-item conv-new"
          onClick={() => onSelect('')}
        >
          + New Conversation
        </button>
        {loading ? (
          <div class="loading">Searching sessions...</div>
        ) : conversations.length === 0 ? (
          <div class="empty" style={{ padding: '12px' }}>No sessions found for this repo.</div>
        ) : (
          <div class="conv-list">
            {conversations.map((conv) => (
              <button
                key={conv.sessionId}
                class={`conv-item ${currentSessionId === conv.sessionId ? 'conv-active' : ''}`}
                onClick={() => onSelect(conv.sessionId)}
              >
                <div class="conv-id">{conv.sessionId.slice(0, 8)}...</div>
                <div class="conv-preview">{conv.firstMessage}</div>
                <div class="conv-time">{new Date(conv.modifiedAt).toLocaleString()}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
