import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { api, Project, ClaudeHistoryMessage, ContextUsage, ImageAttachment } from '../api/rest';
import { useWebSocket } from '../hooks/useWebSocket';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { LogViewer, ChatMessage, ContentBlock, ErrorBlock } from './LogViewer';
import { PromptInput } from './PromptInput';
import { ContextBar } from './ContextBar';
import { ConversationSwitcher } from './ConversationSwitcher';

interface Props {
  id?: string;
  path?: string;
}

interface RawEvent {
  job_id: string;
  job_prompt?: string;
  type: string;
  payload_json: string;
}

/**
 * Convert raw DB events into a flat list of ChatMessages.
 * Groups events by job: user prompt → assistant response text.
 */
function formatToolDetail(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && input.command) return `$ ${input.command}`;
  if (name === 'Edit' && input.file_path) {
    let s = `${input.file_path}`;
    if (input.old_string) {
      const lines = (input.old_string as string).slice(0, 500).split('\n');
      s += '\n' + lines.map(l => `- ${l}`).join('\n');
    }
    if (input.new_string) {
      const lines = (input.new_string as string).slice(0, 500).split('\n');
      s += '\n' + lines.map(l => `+ ${l}`).join('\n');
    }
    return s;
  }
  if (name === 'Write' && input.file_path) return `${input.file_path}`;
  if (name === 'Read' && input.file_path) return `${input.file_path}`;
  if ((name === 'Glob' || name === 'Grep') && input.pattern) return `${input.pattern}`;
  if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
    const lines: string[] = [];
    for (const q of input.questions as Record<string, unknown>[]) {
      lines.push(`**Q:** ${q.question}`);
      if (Array.isArray(q.options)) {
        for (let i = 0; i < (q.options as Record<string, unknown>[]).length; i++) {
          const opt = (q.options as Record<string, unknown>[])[i];
          const desc = opt.description ? ` — ${opt.description}` : '';
          lines.push(`${i + 1}. **${opt.label}**${desc}`);
        }
      }
    }
    lines.push('_ヘッドレスモードのため Claude が代理回答します_');
    return lines.join('\n');
  }
  if (name === 'Agent' && input.description) return input.description as string;
  if (name === 'TodoWrite') return 'Update tasks';
  if (name === 'EnterPlanMode') return '→ Plan mode';
  if (name === 'ExitPlanMode') return '→ Plan ready';
  return JSON.stringify(input, null, 2).slice(0, 500);
}

/**
 * Parse context window limit from model string.
 * e.g. "claude-opus-4-6[1m]" → 1000000, "claude-sonnet-4-6" → 200000
 */
function parseContextLimit(model: string | null): number {
  if (!model) return 200000;
  const match = model.match(/\[(\d+)([km])\]/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    return unit === 'm' ? num * 1000000 : num * 1000;
  }
  return 200000;
}

/** Strip "[Attached images ...]" section appended by server */
function stripImagePaths(text: string): { text: string; hadImages: boolean } {
  const re = /\n?\n?\[Attached images - use Read tool to view:\]\n[\s\S]*$/;
  if (re.test(text)) {
    return { text: text.replace(re, '').trim(), hadImages: true };
  }
  return { text, hadImages: false };
}

function buildChatMessages(rawEvents: RawEvent[], promptImages?: Map<string, string[]>, skipUserPrompts = false): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let currentJobId: string | null = null;
  let blocks: ContentBlock[] = [];
  let textBuffer = '';

  const flushText = () => {
    if (textBuffer.trim()) {
      blocks.push({ type: 'text', text: textBuffer.trim() });
    }
    textBuffer = '';
  };

  const flushAssistant = () => {
    flushText();
    if (blocks.length > 0) {
      messages.push({ role: 'assistant', content: blocks });
    }
    blocks = [];
  };

  for (const raw of rawEvents) {
    if (raw.job_id !== currentJobId) {
      flushAssistant();
      currentJobId = raw.job_id;
      if (raw.job_prompt && !skipUserPrompts) {
        const { text: cleanPrompt, hadImages } = stripImagePaths(raw.job_prompt);
        const imgs = promptImages?.get(cleanPrompt);
        messages.push({
          role: 'user',
          content: [{ type: 'text', text: cleanPrompt }],
          images: imgs && imgs.length > 0 ? imgs : hadImages ? ['attached'] : undefined,
        });
      }
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw.payload_json);
    } catch {
      continue;
    }

    if (parsed.type === 'assistant' && parsed.message) {
      const msg = parsed.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          const b = block as Record<string, unknown>;
          if (b.type === 'text') {
            textBuffer += b.text as string;
          } else if (b.type === 'tool_use') {
            flushText();
            const input = (b.input || {}) as Record<string, unknown>;
            const name = b.name as string;
            const keepInput = name === 'Agent' || name === 'TodoWrite';
            blocks.push({
              type: 'tool',
              name,
              detail: formatToolDetail(name, input),
              toolUseId: b.id as string | undefined,
              ...(keepInput && { input }),
            });
          }
        }
      }
    } else if (parsed.type === 'content_block_delta') {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta') {
        textBuffer += delta.text as string;
      }
    } else if (parsed.type === 'stderr') {
      flushText();
      blocks.push({ type: 'error', text: (parsed.stderr as string || '').trim() } as ErrorBlock);
    } else if (parsed.type === 'result') {
      // Skip - duplicates assistant content
    } else if (parsed.type === 'raw') {
      textBuffer += parsed.raw as string;
    }
  }

  flushAssistant();
  return messages;
}

/**
 * Convert Claude Code JSONL history messages into ChatMessages.
 */
function buildHistoryMessages(history: ClaudeHistoryMessage[], promptImages?: Map<string, string[]>): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const msg of history) {
    const blocks: ContentBlock[] = [];

    if (msg.role === 'user') {
      const rawText = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      // Skip system/notification messages injected into conversation
      if (rawText.includes('<task-notification>') || rawText.includes('<system-reminder>')) {
        continue;
      }
      const { text, hadImages } = stripImagePaths(rawText);
      const imgs = promptImages?.get(text);
      messages.push({
        role: 'user',
        content: [{ type: 'text', text }],
        images: imgs && imgs.length > 0 ? imgs : hadImages ? ['attached'] : undefined,
      });
      continue;
    } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && b.text) {
          blocks.push({ type: 'text', text: b.text as string });
        } else if (b.type === 'tool_use') {
          const input = (b.input || {}) as Record<string, unknown>;
          const name = b.name as string;
          const keepInput = name === 'Agent' || name === 'TodoWrite';
          blocks.push({
            type: 'tool',
            name,
            detail: formatToolDetail(name, input),
            toolUseId: b.id as string | undefined,
            ...(keepInput && { input }),
          });
        }
      }
    }

    if (blocks.length > 0) {
      // Merge consecutive assistant messages into one
      const last = messages[messages.length - 1];
      if (msg.role === 'assistant' && last?.role === 'assistant') {
        last.content = [...last.content, ...blocks];
      } else {
        messages.push({ role: msg.role, content: blocks });
      }
    }
  }

  return messages;
}

/** Generate small thumbnails from data URIs using canvas */
function generateThumbnails(dataUris: string[], maxSize = 96): Promise<string[]> {
  return Promise.all(dataUris.map(uri =>
    new Promise<string>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => resolve(''); // skip on error
      img.src = uri;
    })
  ));
}

function loadStoredImages(projectId: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  try {
    const stored = JSON.parse(localStorage.getItem(`img:${projectId}`) || '{}');
    for (const [prompt, thumbs] of Object.entries(stored)) {
      if (Array.isArray(thumbs) && thumbs.length > 0) {
        map.set(prompt, thumbs as string[]);
      }
    }
  } catch { /* ignore */ }
  return map;
}

const IMG_KEY_PREFIX = 'img:';
const MAX_IMG_PROJECTS = 10;

function saveStoredImages(projectId: string, prompt: string, thumbnails: string[]) {
  try {
    const key = `${IMG_KEY_PREFIX}${projectId}`;
    const stored = JSON.parse(localStorage.getItem(key) || '{}');
    stored[prompt] = thumbnails;
    localStorage.setItem(key, JSON.stringify(stored));

    // Update LRU access order
    const lru: string[] = JSON.parse(localStorage.getItem('img:_lru') || '[]');
    const idx = lru.indexOf(projectId);
    if (idx !== -1) lru.splice(idx, 1);
    lru.push(projectId);
    // Evict oldest projects beyond limit
    while (lru.length > MAX_IMG_PROJECTS) {
      const evict = lru.shift()!;
      localStorage.removeItem(`${IMG_KEY_PREFIX}${evict}`);
    }
    localStorage.setItem('img:_lru', JSON.stringify(lru));
  } catch { /* localStorage full — degrade gracefully */ }
}

export function ProjectDetail({ id }: Props) {
  const [project, setProject] = useState<Project | null>(null);
  const [historyMessages, setHistoryMessages] = useState<ChatMessage[]>([]);
  const [rawEvents, setRawEvents] = useState<RawEvent[]>([]);
  const [streamEvents, setStreamEvents] = useState<RawEvent[]>([]);
  const currentJobPromptRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [jobActive, setJobActive] = useState(false);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const promptImagesRef = useRef<Map<string, string[]>>(id ? loadStoredImages(id) : new Map());

  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const contextLimitRef = useRef(200000);

  const loadHistory = useCallback(async (proj: Project) => {
    if (proj.claude_session_id) {
      const history = await api.getClaudeHistory(proj.id);
      setHistoryMessages(buildHistoryMessages(history, promptImagesRef.current));
    }
  }, []);

  const loadProject = useCallback(async () => {
    if (!id) return;
    try {
      const proj = await api.getProject(id);
      setProject(proj);

      // Clear stale streaming state on reload (e.g. returning from background)
      // pendingPrompt is always cleared — JSONL/DB history already contains the user prompt
      setPendingPrompt(null);
      const isIdle = proj.state !== 'RUNNING' && proj.state !== 'STOPPING';
      setJobActive(!isIdle);
      setStreamEvents([]);

      api.getGitBranch(proj.id).then(r => setGitBranch(r.branch)).catch(() => {});

      if (proj.claude_session_id) {
        // Linked: Claude JSONL is the single source of truth
        await loadHistory(proj);
        setRawEvents([]);
        api.getContextUsage(proj.id).then(usage => {
          setContextUsage(usage);
          if (usage?.limit) contextLimitRef.current = usage.limit;
        }).catch(() => {});
      } else {
        // Unlinked: use PWA events only
        const evts = await api.getProjectEvents(id);
        setRawEvents(evts as RawEvent[]);
      }
    } catch {
      // Ignore load errors
    } finally {
      setLoading(false);
    }
  }, [id, loadHistory]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  usePageVisibility(loadProject);

  // WebSocket real-time updates
  useWebSocket(id || null, (msg) => {
    const m = msg as Record<string, unknown>;
    if (m.type === 'project_state') {
      setProject((prev) => (prev ? { ...prev, state: m.state as string } : prev));
    } else if (m.type === 'job_started') {
      currentJobPromptRef.current = m.prompt as string || null;
      // Clear pendingPrompt for unlinked mode (stream events will show the prompt via job_prompt).
      // For linked mode, pendingPrompt stays until job_finished when JSONL is reloaded.
      setProject((prev) => {
        if (prev && !prev.claude_session_id) setPendingPrompt(null);
        return prev ? { ...prev, last_job_id: m.jobId as string } : prev;
      });
    } else if (m.type === 'event') {
      const data = m.data as Record<string, unknown>;
      // Extract context limit from system init event
      if (data.type === 'system' && data.subtype === 'init' && data.model) {
        contextLimitRef.current = parseContextLimit(data.model as string);
      }
      // Extract context usage from assistant events
      if (data.type === 'assistant') {
        const msg = data.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, number> | undefined;
        if (usage) {
          const used = (usage.input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0)
            + (usage.cache_read_input_tokens || 0);
          const model = (msg?.model as string) || null;
          setContextUsage({ used, limit: contextLimitRef.current, model });
        }
      }
      setStreamEvents((prev) => [
        ...prev,
        {
          job_id: m.jobId as string,
          job_prompt: currentJobPromptRef.current || undefined,
          type: (data.type as string) || 'unknown',
          payload_json: JSON.stringify(data),
        },
      ]);
    } else if (m.type === 'job_finished') {
      setPendingPrompt(null);
      setJobActive(false);
      setProject((prev) => {
        const updated = prev ? { ...prev, state: 'IDLE' as const } : prev;
        // Reload from JSONL if linked, otherwise from PWA events
        if (id && updated) {
          if (updated.claude_session_id) {
            loadHistory(updated).then(() => {
              // Keep stderr events since JSONL history doesn't include them
              setStreamEvents(prev => prev.filter(e => e.type === 'stderr'));
              currentJobPromptRef.current = null;
            }).catch(() => {});
            api.getContextUsage(id).then(usage => {
              setContextUsage(usage);
              if (usage?.limit) contextLimitRef.current = usage.limit;
            }).catch(() => {});
          } else {
            api.getProjectEvents(id).then((evts) => {
              setRawEvents(evts as RawEvent[]);
              setStreamEvents([]);
              currentJobPromptRef.current = null;
            }).catch(() => {});
          }
        }
        return updated;
      });
    }
  });

  const chatMessages = useMemo(() => {
    let msgs: ChatMessage[];
    const imgMap = promptImagesRef.current;
    const pendingMsg: ChatMessage | null = pendingPrompt ? {
      role: 'user',
      content: [{ type: 'text', text: pendingPrompt }],
      images: pendingImages.length > 0 ? pendingImages : undefined,
    } : null;

    if (historyMessages.length > 0) {
      // Linked: JSONL history is the source, append only live streaming
      // Skip user prompts from stream — already included in JSONL history
      // Insert pendingPrompt between history and live messages so it appears
      // above Claude's response, not below it
      const liveMessages = buildChatMessages(streamEvents, imgMap, true);
      msgs = [...historyMessages, ...(pendingMsg ? [pendingMsg] : []), ...liveMessages];
    } else {
      // Unlinked: PWA events only
      msgs = buildChatMessages([...rawEvents, ...streamEvents], imgMap);
      if (pendingMsg) msgs = [...msgs, pendingMsg];
    }
    return msgs;
  }, [historyMessages, rawEvents, streamEvents, pendingPrompt, pendingImages]);

  const handleRun = async (prompt: string, images?: ImageAttachment[]) => {
    if (!id) return;
    setPendingPrompt(prompt);
    const dataUris = images ? images.map((img) => `data:${img.mediaType};base64,${img.data}`) : [];
    setPendingImages(dataUris);
    if (dataUris.length > 0) {
      promptImagesRef.current.set(prompt, dataUris);
      // Generate thumbnails and persist to localStorage
      generateThumbnails(dataUris).then((thumbs) => {
        promptImagesRef.current.set(prompt, thumbs);
        saveStoredImages(id, prompt, thumbs);
      });
    }
    setJobActive(true);
    currentJobPromptRef.current = prompt;
    try {
      await api.runJob(id, prompt, images);
    } catch (err) {
      setPendingPrompt(null);
      setJobActive(false);
      alert(err instanceof Error ? err.message : 'Failed to run job');
    }
  };

  const handleCancel = async () => {
    if (!project?.last_job_id) return;
    try {
      await api.cancelJob(project.last_job_id);
    } catch {
      alert('Failed to cancel job');
    }
  };

  const handleLinkConversation = async (claudeSessionId: string) => {
    if (!id) return;
    try {
      const updated = await api.updateProject(id, {
        claudeSessionId: claudeSessionId || null,
      });
      setProject(updated);
      setShowLinkPanel(false);
      // Reset display state for the new/switched conversation
      setHistoryMessages([]);
      setStreamEvents([]);
      setRawEvents([]);
      setContextUsage(null);
      if (claudeSessionId) {
        // Load history for the selected conversation
        await loadHistory(updated);
        api.getContextUsage(id).then(usage => {
              setContextUsage(usage);
              if (usage?.limit) contextLimitRef.current = usage.limit;
            }).catch(() => {});
      }
    } catch {
      alert('Failed to switch conversation');
    }
  };

  if (loading) return <div class="page"><div class="loading">Loading...</div></div>;
  if (!project) return <div class="page"><div class="error">Project not found</div></div>;

  const isRunning = project.state === 'RUNNING' || project.state === 'STOPPING';

  const contextPct = contextUsage ? Math.min(100, Math.round(contextUsage.used / contextUsage.limit * 100)) : 0;
  const contextLevel = contextPct >= 80 ? 'danger' : contextPct >= 60 ? 'warning' : 'normal';

  return (
    <div class="page project-detail">
      <header class="header">
        <a href="/" class="back-link" title="Back to project list">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
          <h1>{project.name}</h1>
          <span class={`state-badge state-${project.state.toLowerCase()} mobile-only`}>
            {project.state}
          </span>
        </a>
        <button class="btn-icon header-icon-btn" onClick={() => setShowLinkPanel(!showLinkPanel)} title="Switch conversation">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <rect x="1" y="1" width="15" height="12" rx="2.5" />
            <path style={{ fill: 'var(--bg-primary)' }} d="M9.5 7H19.5A2.5 2.5 0 0122 9.5V16.5A2.5 2.5 0 0119.5 19H14L12 22V19H9.5A2.5 2.5 0 017 16.5V9.5A2.5 2.5 0 019.5 7Z" />
          </svg>
        </button>
      </header>

      <div class="mobile-only">
        {(contextUsage || gitBranch) && (
          <ContextBar contextUsage={contextUsage} gitBranch={gitBranch} />
        )}
      </div>

      <ConversationSwitcher
        projectId={id!}
        currentSessionId={project.claude_session_id}
        isOpen={showLinkPanel}
        onClose={() => setShowLinkPanel(false)}
        onSelect={handleLinkConversation}
      />

      <div class="project-detail-body">
        <LogViewer
              messages={chatMessages}
              loading={!!pendingPrompt || jobActive}
              loadingLabel={pendingPrompt ? 'Thinking...' : 'Running...'}
              projectId={id}
            />
        <PromptInput projectId={id} onSubmit={handleRun} onCancel={handleCancel} disabled={isRunning} running={isRunning} />
      </div>

      <aside class={`detail-sidebar context-${contextLevel}`}>
        <div class="sidebar-item">
          <span class={`state-badge state-${project.state.toLowerCase()}`}>
            {project.state}
          </span>
        </div>
        {contextUsage?.model && (
          <div class="sidebar-item">
            <svg class="sidebar-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2" />
              <rect x="8" y="8" width="8" height="8" rx="1" />
              <line x1="12" y1="2" x2="12" y2="4" />
              <line x1="12" y1="20" x2="12" y2="22" />
              <line x1="2" y1="12" x2="4" y2="12" />
              <line x1="20" y1="12" x2="22" y2="12" />
              <line x1="7" y1="2" x2="7" y2="4" />
              <line x1="17" y1="2" x2="17" y2="4" />
              <line x1="7" y1="20" x2="7" y2="22" />
              <line x1="17" y1="20" x2="17" y2="22" />
              <line x1="2" y1="7" x2="4" y2="7" />
              <line x1="2" y1="17" x2="4" y2="17" />
              <line x1="20" y1="7" x2="22" y2="7" />
              <line x1="20" y1="17" x2="22" y2="17" />
            </svg>
            <span class="sidebar-label">{contextUsage.model.replace('claude-', '')}</span>
          </div>
        )}
        {contextUsage && (
          <div class="sidebar-item">
            <svg class="sidebar-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              <circle cx="12" cy="12" r="4" />
            </svg>
            <div class="sidebar-context">
              <span class="sidebar-label context-meter">
                {Math.round(contextUsage.used / 1000)}k/{Math.round(contextUsage.limit / 1000)}k
              </span>
              <div class="sidebar-meter">
                <div class="sidebar-meter-fill" style={{ width: `${contextPct}%` }} />
              </div>
            </div>
          </div>
        )}
        {gitBranch && (
          <div class="sidebar-item">
            <svg class="sidebar-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span class="sidebar-label">{gitBranch}</span>
          </div>
        )}
      </aside>
    </div>
  );
}
