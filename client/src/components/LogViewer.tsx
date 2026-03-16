import { useEffect, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolBlock {
  type: 'tool';
  name: string;
  detail: string;
}

export interface ErrorBlock {
  type: 'error';
  text: string;
}

export type ContentBlock = TextBlock | ToolBlock | ErrorBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  images?: string[];  // data URIs for user-attached image thumbnails
}

interface Props {
  messages: ChatMessage[];
  loading?: boolean;
  loadingLabel?: string;
}

// Configure marked for compact output
marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

function getPreview(detail: string): string {
  const first = detail.split('\n')[0].trim();
  if (first.length > 60) return first.slice(0, 60) + '...';
  return first;
}

const STATUS_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode']);

function renderBlock(block: ContentBlock, key: number) {
  if (block.type === 'text') {
    const html = renderMarkdown(block.text);
    return <div key={key} class="chat-content" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (block.type === 'error') {
    return <div key={key} class="chat-error">{block.text}</div>;
  }
  if (block.name === 'AskUserQuestion') {
    const html = renderMarkdown(block.detail);
    return <div key={key} class="tool-question" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (STATUS_TOOLS.has(block.name)) {
    return <div key={key} class="tool-status">{block.detail}</div>;
  }
  const preview = getPreview(block.detail);
  return (
    <details key={key} class="tool-block">
      <summary class="tool-summary">
        {block.name} <span class="tool-preview">{preview}</span>
      </summary>
      <pre class="tool-detail">{block.detail}</pre>
    </details>
  );
}

function getLatestPreview(messages: ChatMessage[]): { role: 'user' | 'assistant'; text: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    for (let j = msg.content.length - 1; j >= 0; j--) {
      const block = msg.content[j];
      if (block.type === 'text' && block.text.trim()) {
        const text = block.text.trim().split('\n')[0];
        return { role: msg.role, text: text.length > 30 ? text.slice(0, 30) + '...' : text };
      }
      if (block.type === 'tool') {
        const preview = block.detail.split('\n')[0].trim();
        const label = `${block.name}: ${preview}`;
        return { role: msg.role, text: label.length > 30 ? label.slice(0, 30) + '...' : label };
      }
    }
  }
  return { role: 'assistant', text: 'New messages' };
}

function countBlocks(messages: ChatMessage[]): number {
  let n = 0;
  for (const msg of messages) n += msg.content.length;
  return n;
}

export function LogViewer({ messages, loading, loadingLabel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);
  const userInteracting = useRef(false);
  const scrollTimer = useRef<number>(0);
  const prevBlockCount = useRef(0);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    const currentCount = countBlocks(messages);
    const isNew = currentCount > prevBlockCount.current;
    prevBlockCount.current = currentCount;

    if (el && shouldAutoScroll.current) {
      el.scrollTop = el.scrollHeight;
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    } else if (el && !shouldAutoScroll.current && isNew) {
      setHasNewMessages(true);
    }
  }, [messages]);

  // Track user touch/mouse to detect intentional scroll-away
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onStart = () => { userInteracting.current = true; };
    const onEnd = () => { userInteracting.current = false; };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('mousedown', onStart);
    el.addEventListener('mouseup', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('mousedown', onStart);
      el.removeEventListener('mouseup', onEnd);
    };
  }, []);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;

    // Immediately detect user scrolling away from bottom
    if (userInteracting.current) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      if (!atBottom) shouldAutoScroll.current = false;
    }

    // Debounced: re-check after scrolling fully stops (handles momentum)
    clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      shouldAutoScroll.current = atBottom;
      if (atBottom) setHasNewMessages(false);
    }, 150);
  };

  const scrollToBottom = () => {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      shouldAutoScroll.current = true;
      setHasNewMessages(false);
    }
  };

  const latest = hasNewMessages ? getLatestPreview(messages) : null;

  return (
    <div class="log-viewer" ref={containerRef} onScroll={handleScroll}>
      {messages.length === 0 && <div class="log-empty">No messages yet.</div>}
      {messages.map((msg, i) => (
        <div key={i} class={`chat-msg chat-${msg.role}`}>
          <div class="chat-role">{msg.role === 'user' ? 'You' : 'Claude'}</div>
          {msg.content.map((block, j) => renderBlock(block, j))}
          {msg.images && msg.images.length > 0 && (
            <div class="chat-images">
              {msg.images[0] === 'attached' ? (
                <span class="chat-image-placeholder">image attached</span>
              ) : (
                msg.images.map((src, k) => (
                  <img key={k} src={src} alt="" class="chat-image-thumb" />
                ))
              )}
            </div>
          )}
        </div>
      ))}
      {loading && (
        <div class="loading-indicator">
          <span class="loading-dots">
            <span /><span /><span />
          </span>
          {loadingLabel || 'Thinking...'}
        </div>
      )}
      {hasNewMessages && latest && (
        <button class={`new-messages-btn new-msg-${latest.role}`} onClick={scrollToBottom}>
          {latest.role === 'user' ? 'You' : 'Claude'}: {latest.text}
        </button>
      )}
    </div>
  );
}
