import { useState, useEffect } from 'preact/hooks';
import { api, ClaudeConversation } from '../api/rest';
import { BottomSheet } from './BottomSheet';

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

  const footer = (
    <button class="conv-new" onClick={() => onSelect('')}>
      + New Conversation
    </button>
  );

  return (
    <BottomSheet title="Conversations" onClose={onClose} footer={footer}>
      <div style={{ padding: '0 16px' }}>
        {loading ? (
          <div class="loading">Searching conversations...</div>
        ) : conversations.length === 0 ? (
          <div class="empty" style={{ padding: '12px' }}>No conversations found for this repo.</div>
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
    </BottomSheet>
  );
}
