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
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    api.getClaudeConversations(projectId)
      .then(setConversations)
      .catch(() => setConversations([]))
      .finally(() => setLoading(false));
  }, [isOpen, projectId]);

  if (!isOpen) return null;

  const handleCopyResume = async (e: MouseEvent, sessionId: string) => {
    e.stopPropagation();
    e.preventDefault();
    const cmd = `claude --resume ${sessionId}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedId(sessionId);
      setTimeout(() => setCopiedId((cur) => (cur === sessionId ? null : cur)), 1500);
    } catch {
      // Fallback for non-secure contexts: select-and-execCommand
      const ta = document.createElement('textarea');
      ta.value = cmd;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopiedId(sessionId); setTimeout(() => setCopiedId((cur) => (cur === sessionId ? null : cur)), 1500); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  };

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
            {conversations.map((conv) => {
              const isCopied = copiedId === conv.sessionId;
              return (
                <div key={conv.sessionId} class="conv-row">
                  <button
                    class={`conv-item ${currentSessionId === conv.sessionId ? 'conv-active' : ''}`}
                    onClick={() => onSelect(conv.sessionId)}
                  >
                    <div class="conv-id">{conv.sessionId.slice(0, 8)}...</div>
                    <div class="conv-preview">{conv.firstMessage}</div>
                    <div class="conv-time">{new Date(conv.modifiedAt).toLocaleString()}</div>
                  </button>
                  <button
                    class={`conv-copy-btn desktop-only${isCopied ? ' is-copied' : ''}`}
                    onClick={(e) => handleCopyResume(e, conv.sessionId)}
                    title={`Copy: claude --resume ${conv.sessionId}`}
                    aria-label="Copy resume command"
                  >
                    {isCopied ? (
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </BottomSheet>
  );
}
