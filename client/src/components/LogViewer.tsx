import { ComponentChildren } from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api/rest';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import 'highlight.js/styles/github-dark.min.css';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('python', python);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdown);

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolBlock {
  type: 'tool';
  name: string;
  detail: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
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

/** Try to detect language from file extension */
function detectLang(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', css: 'css', html: 'xml', xml: 'xml', svg: 'xml',
    py: 'python', yml: 'yaml', yaml: 'yaml', md: 'markdown',
    sh: 'bash', bash: 'bash', zsh: 'bash',
  };
  return ext ? map[ext] : undefined;
}

function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(code, { language: lang }).value;
  }
  return hljs.highlightAuto(code).value;
}

interface Props {
  messages: ChatMessage[];
  loading?: boolean;
  loadingLabel?: string;
  projectId?: string;
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

function renderDiff(detail: string) {
  const lines = detail.split('\n');
  const filePath = lines[0];
  const diffLines = lines.slice(1);
  const lang = detectLang(filePath);

  // Highlight each line's code content (strip prefix, highlight, re-add prefix)
  const highlighted = diffLines.map(line => {
    const isDel = line.startsWith('- ');
    const isAdd = line.startsWith('+ ');
    if (!isDel && !isAdd) return { cls: 'diff-ctx', prefix: '', html: line };
    const prefix = line.slice(0, 2);
    const code = line.slice(2);
    const html = lang ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : code;
    return { cls: isDel ? 'diff-del' : 'diff-add', prefix, html };
  });

  return (
    <div class="tool-diff">
      <div class="diff-header">{filePath}</div>
      <div class="diff-body">
        {highlighted.map((h, i) => (
          <div key={i} class={`diff-line ${h.cls}`}>
            <span class="diff-prefix">{h.prefix}</span>
            <span class="diff-code" dangerouslySetInnerHTML={{ __html: h.html }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Parse cat -n style output (e.g. "     1→content") into line-numbered code view
 * with syntax highlighting. Returns null if the content doesn't match the pattern.
 */
function renderCodeResult(text: string, filePath?: string) {
  const lines = text.split('\n');
  const catLineRe = /^\s*(\d+)→(.*)$/;
  const parsed = lines.map(l => catLineRe.exec(l));
  const isCatFormat = parsed.filter(Boolean).length > lines.length * 0.5;

  if (!isCatFormat) return null;

  // Extract code content, highlight, then split back
  const codeLines = lines.map((l, i) => parsed[i] ? parsed[i]![2] : l);
  const lang = filePath ? detectLang(filePath) : undefined;
  const highlighted = highlightCode(codeLines.join('\n'), lang);
  const hlLines = highlighted.split('\n');

  return (
    <div class="code-viewer">
      {lines.map((line, i) => {
        const m = parsed[i];
        return (
          <div key={i} class="code-line">
            <span class="code-ln">{m ? m[1] : ''}</span>
            <span class="code-text" dangerouslySetInnerHTML={{ __html: hlLines[i] || '' }} />
          </div>
        );
      })}
    </div>
  );
}

const TRUNCATE_HEIGHT = 250;

function ContentModal({ title, children, onClose }: { title: string; children: ComponentChildren; onClose: () => void }) {
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div class="content-modal-overlay" onClick={onClose}>
      <div class="content-modal" onClick={(e) => e.stopPropagation()}>
        <div class="content-modal-header">
          <span class="content-modal-title">{title}</span>
          <button class="content-modal-close" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div class="content-modal-body">
          {children}
        </div>
      </div>
    </div>
  );
}

function Truncatable({ children, maxHeight = TRUNCATE_HEIGHT, title = 'Detail' }: { children: ComponentChildren; maxHeight?: number; title?: string }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [needsTruncate, setNeedsTruncate] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (el && el.scrollHeight > maxHeight + 40) {
      setNeedsTruncate(true);
    }
  }, [children, maxHeight]);

  return (
    <>
      <div class={`truncatable ${needsTruncate ? 'truncated' : ''}`}>
        <div ref={contentRef} class="truncatable-content" style={needsTruncate ? { maxHeight: `${maxHeight}px` } : undefined}>
          {children}
        </div>
        {needsTruncate && (
          <button class="truncatable-view" onClick={() => setModalOpen(true)}>
            View full content
          </button>
        )}
      </div>
      {modalOpen && (
        <ContentModal title={title} onClose={() => setModalOpen(false)}>
          {children}
        </ContentModal>
      )}
    </>
  );
}

function renderAgent(input: Record<string, unknown>) {
  const agentType = input.subagent_type as string || 'general';
  const desc = input.description as string || '';
  const prompt = input.prompt as string || '';

  return (
    <div class="agent-detail">
      <div class="agent-meta">
        <span class="agent-type">{agentType}</span>
        {desc && <span class="agent-desc">{desc}</span>}
      </div>
      {prompt && <pre class="agent-prompt">{prompt}</pre>}
    </div>
  );
}

interface TodoItem {
  content: string;
  status: string;
  activeForm?: string;
}

function renderTodoWrite(input: Record<string, unknown>) {
  const todos = (input.todos || []) as TodoItem[];
  return (
    <div class="todo-detail">
      {todos.map((todo, i) => (
        <div key={i} class={`todo-item todo-${todo.status}`}>
          <span class="todo-check">
            {todo.status === 'completed' ? '\u2713' : todo.status === 'in_progress' ? '\u25b6' : '\u25cb'}
          </span>
          <span class="todo-text">{todo.content}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Try to extract text from structured content (e.g. Agent results).
 * Agent results are JSON arrays like [{"type":"text","text":"..."}].
 */
function tryParseStructuredResult(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    const texts = parsed
      .filter((b: Record<string, unknown>) => b.type === 'text' && b.text)
      .map((b: Record<string, unknown>) => b.text as string);
    return texts.length > 0 ? texts.join('\n\n') : null;
  } catch {
    return null;
  }
}

function renderToolResult(result: string, toolName: string, filePath?: string) {
  // Try structured content (Agent results)
  const structured = tryParseStructuredResult(result);
  if (structured) {
    const html = renderMarkdown(structured);
    return <div class="tool-result-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  // Try code viewer (Read results with cat -n format)
  const codeView = renderCodeResult(result, filePath);
  if (codeView) return codeView;
  // Fallback: plain pre
  return <pre class="tool-result-content">{result}</pre>;
}

function ToolBlockView({ block, projectId }: { block: ToolBlock; projectId?: string }) {
  const [result, setResult] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetched = useRef(false);

  const handleToggle = useCallback((e: Event) => {
    const details = e.target as HTMLDetailsElement;
    if (!details.open || fetched.current || !block.toolUseId || !projectId) return;
    fetched.current = true;
    setLoading(true);
    api.getToolResult(projectId, block.toolUseId).then(r => {
      if (r.result) setResult(r.result);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [block.toolUseId, projectId]);

  const preview = getPreview(block.detail);
  // Extract file path from detail for language detection
  const filePath = (block.name === 'Read' || block.name === 'Write') ? block.detail.trim() : undefined;

  const renderDetail = () => {
    if (block.name === 'Edit') return renderDiff(block.detail);
    if (block.name === 'Bash') {
      const html = highlightCode(block.detail, 'bash');
      return <pre class="tool-detail" dangerouslySetInnerHTML={{ __html: html }} />;
    }
    if (block.name === 'Agent' && block.input) return renderAgent(block.input);
    if (block.name === 'TodoWrite' && block.input) return renderTodoWrite(block.input);
    return <pre class="tool-detail">{block.detail}</pre>;
  };

  const resultContent = result ? renderToolResult(result, block.name, filePath) : null;

  return (
    <details class="tool-block" onToggle={handleToggle}>
      <summary class="tool-summary">
        {block.name} <span class="tool-preview">{preview}</span>
      </summary>
      <Truncatable title={`${block.name} — Input`}>
        {renderDetail()}
      </Truncatable>
      {loading && <div class="tool-result-loading">Loading...</div>}
      {resultContent && (
        <div class="tool-result">
          <div class="tool-result-header">Result</div>
          <Truncatable title={`${block.name} — Result`}>
            {resultContent}
          </Truncatable>
        </div>
      )}
    </details>
  );
}

function renderBlock(block: ContentBlock, key: number, projectId?: string) {
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
  return <ToolBlockView key={key} block={block} projectId={projectId} />;
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

export function LogViewer({ messages, loading, loadingLabel, projectId }: Props) {
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
          {msg.content.map((block, j) => renderBlock(block, j, projectId))}
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
