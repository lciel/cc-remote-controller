import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { route } from 'preact-router';
import { api, Project, ClaudeHistoryMessage, ContextUsage, ImageAttachment, TeamSnapshot, TeamMember } from '../api/rest';
import { useWebSocket } from '../hooks/useWebSocket';
import { usePageVisibility } from '../hooks/usePageVisibility';
import { LogViewer, ChatMessage, ContentBlock, ErrorBlock } from './LogViewer';
import { PromptInput } from './PromptInput';
import { ContextBar, contextLevel as getContextLevel } from './ContextBar';
import { ConversationSwitcher } from './ConversationSwitcher';
import { BottomSheet } from './BottomSheet';
import { FileBrowser, invalidateFileListCache } from './FileBrowser';
import { FilePreviewSheet } from './FilePreviewSheet';
import { TeamPanel } from './TeamPanel';
import { TeamMemberSheet } from './TeamMemberSheet';
import { useDriveMode } from '../hooks/useDriveMode';

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
  if (name === 'Skill' && input.skill) return input.args ? `/${input.skill} ${input.args}` : `/${input.skill}`;
  if (name === 'ToolSearch') return input.query as string || '';
  if (name === 'WebFetch' && input.url) return input.url as string;
  if (name === 'WebSearch' && input.query) return input.query as string;
  if (name === 'SendMessage' && input.to) return `→ ${input.to}`;
  if (name === 'NotebookEdit' && input.notebook_path) return input.notebook_path as string;
  if (name === 'TaskOutput' || name === 'TaskStop') return input.task_id ? `task ${input.task_id}` : name;
  if (name === 'EnterWorktree') return '→ worktree';
  if (name === 'ExitWorktree') return '← worktree';
  if (name === 'CronCreate' && input.schedule) return input.schedule as string;
  if (name === 'CronDelete' && input.cron_id) return input.cron_id as string;
  if (name === 'CronList') return 'list';
  if (name === 'RemoteTrigger') return input.trigger_id as string || 'trigger';
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
  if (/claude-opus-4-[67]/.test(model)) return 1000000;
  return 200000;
}

/** Strip drive mode prefix from displayed user prompts */
function stripDrivePrefix(text: string): string {
  return text.replace(/^【ドライブモード】[^\n]*\n+/, '');
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
        const { text: stripped, hadImages } = stripImagePaths(raw.job_prompt);
        const cleanPrompt = stripDrivePrefix(stripped);
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
      const { text: stripped, hadImages } = stripImagePaths(rawText);
      const text = stripDrivePrefix(stripped);
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

/**
 * Walk ancestors from `el` and return true if any can still horizontally
 * scroll in the given direction. Used to defer drawer-drag gestures to
 * nested horizontally-scrollable content (e.g. code blocks).
 */
function ancestorCanScrollHorizontally(el: Element | null, direction: 'left' | 'right', stopAt?: Element | null): boolean {
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    if (stopAt && cur === stopAt) break;
    if (cur instanceof HTMLElement) {
      const style = window.getComputedStyle(cur);
      const overflowX = style.overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') {
        if (cur.scrollWidth > cur.clientWidth + 1) {
          if (direction === 'left') {
            // Finger moves left → content moves left → scrollLeft increases.
            // Element can consume if it can scroll further right.
            if (cur.scrollLeft < cur.scrollWidth - cur.clientWidth - 1) return true;
          } else {
            // Finger moves right → scrollLeft decreases.
            if (cur.scrollLeft > 1) return true;
          }
        }
      }
    }
    cur = cur.parentElement;
  }
  return false;
}

/**
 * Animate a numeric value from `from` to `to` over `duration` ms with ease-out.
 * Returns a cancel function.
 */
function animateValue(
  from: number,
  to: number,
  duration: number,
  onUpdate: (v: number) => void,
  onDone: () => void
): () => void {
  const start = performance.now();
  let rafId = 0;
  let cancelled = false;
  const tick = (now: number) => {
    if (cancelled) return;
    const t = Math.min((now - start) / duration, 1);
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3);
    onUpdate(from + (to - from) * eased);
    if (t < 1) rafId = requestAnimationFrame(tick);
    else onDone();
  };
  rafId = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(rafId); };
}

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
  const [showProjectMenu, setShowProjectMenu] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showFileBrowser, setShowFileBrowser] = useState(false);
  const [drawerDragX, setDrawerDragX] = useState<number | null>(null);
  const drawerDragRef = useRef<{ startX: number; startY: number; startTime: number; panelWidth: number; committed: boolean; target: Element | null } | null>(null);
  const drawerAnimCancelRef = useRef<(() => void) | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const failedPromptKey = id ? `failed-prompt:${id}` : null;
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(() =>
    failedPromptKey ? localStorage.getItem(failedPromptKey) : null
  );
  const [pendingFailed, setPendingFailed] = useState(() => !!failedPromptKey && !!localStorage.getItem(failedPromptKey));
  const pendingImagesRef = useRef<ImageAttachment[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  const contextLimitRef = useRef(200000);
  const [team, setTeam] = useState<TeamSnapshot | null>(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);

  const refreshTeam = useCallback(() => {
    if (!id) return;
    setTeamLoading(true);
    api.getTeam(id).then((res) => {
      setTeam(res.team);
    }).catch(() => {
      setTeam(null);
    }).finally(() => {
      setTeamLoading(false);
    });
  }, [id]);

  useEffect(() => {
    if (!id || !project) return;
    if (project.team_mode) {
      refreshTeam();
    } else {
      setTeam(null);
    }
  }, [id, project?.team_mode, project?.claude_session_id, refreshTeam]);

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
      // Keep failed prompt so user can retry — only clear if no failed prompt persisted
      if (!failedPromptKey || !localStorage.getItem(failedPromptKey)) setPendingPrompt(null);
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
      setJobActive(true);
      // Clear pendingPrompt for unlinked mode (stream events will show the prompt via job_prompt).
      // For linked mode, pendingPrompt stays until job_finished when JSONL is reloaded.
      setProject((prev) => {
        if (prev && !prev.claude_session_id) {
          if (failedPromptKey) localStorage.removeItem(failedPromptKey);
          setPendingFailed(false);
          setPendingPrompt(null);
        }
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
    } else if (m.type === 'team_update') {
      refreshTeam();
    } else if (m.type === 'job_finished') {
      if (failedPromptKey) localStorage.removeItem(failedPromptKey);
      setPendingFailed(false);
      setPendingPrompt(null);
      setJobActive(false);
      // Re-fetch project to get latest claude_session_id (may have been set during job)
      if (id) {
        api.getProject(id).then((fresh) => {
          setProject(fresh);
          if (fresh.claude_session_id) {
            loadHistory(fresh).then(() => {
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
        }).catch(() => {});
      }
    }
  });

  const chatMessages = useMemo(() => {
    let msgs: ChatMessage[];
    const imgMap = promptImagesRef.current;
    const pendingMsg: ChatMessage | null = pendingPrompt ? {
      role: 'user',
      content: [{ type: 'text', text: stripDrivePrefix(pendingPrompt) }],
      images: pendingImages.length > 0 ? pendingImages : undefined,
      status: pendingFailed ? 'failed' : undefined,
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
  }, [historyMessages, rawEvents, streamEvents, pendingPrompt, pendingImages, pendingFailed]);

  const handleRun = async (prompt: string, images?: ImageAttachment[]) => {
    if (!id) return;
    // Claude may modify files during the job — drop cached listings for this project
    invalidateFileListCache(id);
    setPendingPrompt(prompt);
    setPendingFailed(false);
    pendingImagesRef.current = images || [];
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
      if (failedPromptKey) localStorage.removeItem(failedPromptKey);
    } catch (err) {
      setJobActive(false);
      if (failedPromptKey) localStorage.setItem(failedPromptKey, prompt);
      setPendingFailed(true);
    }
  };

  const handleRetry = () => {
    if (!pendingPrompt) return;
    handleRun(pendingPrompt, pendingImagesRef.current.length > 0 ? pendingImagesRef.current : undefined);
  };

  const handleDiscard = () => {
    if (failedPromptKey) localStorage.removeItem(failedPromptKey);
    setPendingPrompt(null);
    setPendingFailed(false);
    setPendingImages([]);
    pendingImagesRef.current = [];
  };

  const handleCancel = async () => {
    if (!project?.last_job_id) return;
    try {
      await api.cancelJob(project.last_job_id);
    } catch {
      alert('Failed to cancel job');
    }
  };

  // Desktop button-driven open: animate slide-in from offscreen using the same
  // rAF driver as the mobile drag-release path.
  const handleOpenFileBrowser = () => {
    if (showFileBrowser) return;
    if (drawerAnimCancelRef.current) {
      drawerAnimCancelRef.current();
      drawerAnimCancelRef.current = null;
    }
    const panelWidth = Math.min(window.innerWidth, 500);
    setShowFileBrowser(true);
    setDrawerDragX(panelWidth);
    drawerAnimCancelRef.current = animateValue(
      panelWidth,
      0,
      200,
      (v) => setDrawerDragX(v),
      () => {
        drawerAnimCancelRef.current = null;
        setDrawerDragX(null);
      }
    );
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

  const handleDeleteProject = async () => {
    if (!id) return;
    try {
      await api.deleteProject(id);
      route('/');
    } catch {
      alert('Failed to delete project');
    }
  };

  // Extract latest assistant text for TTS
  const latestAssistantText = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      const msg = chatMessages[i];
      if (msg.role !== 'assistant') continue;
      const texts = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text);
      if (texts.length > 0) return texts.join('\n');
    }
    return '';
  }, [chatMessages]);

  const driveMode = useDriveMode({
    onSubmit: (prompt) => handleRun(prompt),
    jobActive,
    latestAssistantText,
    onCommand: (text) => {
      // Voice command: start a new conversation by unlinking current session
      if (/新しい(会話|かいわ)|新規(会話|かいわ)|会話.*(作|始|新)/.test(text)) {
        handleLinkConversation('');
        return true;
      }
      return false;
    },
  });

  if (loading) return (
    <div class="page">
      <div class="loading-splash">
        <svg viewBox="0 0 20 14" width="120" height="84" shape-rendering="crispEdges">
          <rect x="0" y="4" width="3" height="4" fill="#c07a50" />
          <rect x="17" y="4" width="3" height="4" fill="#c07a50" />
          <rect x="3" y="0" width="14" height="11" fill="#c07a50" />
          <rect x="6" y="4" width="2" height="3" fill="#2c1810" />
          <rect x="13" y="4" width="2" height="3" fill="#2c1810" />
          <rect x="5" y="11" width="2" height="3" fill="#c07a50" />
          <rect x="8" y="11" width="2" height="3" fill="#c07a50" />
          <rect x="11" y="11" width="2" height="3" fill="#c07a50" />
          <rect x="14" y="11" width="2" height="3" fill="#c07a50" />
        </svg>
      </div>
    </div>
  );
  if (!project) return <div class="page"><div class="error">Project not found</div></div>;

  const isRunning = project.state === 'RUNNING' || project.state === 'STOPPING';

  const contextPct = contextUsage ? Math.min(100, Math.round(contextUsage.used / contextUsage.limit * 100)) : 0;
  const ctxLevel = contextUsage ? getContextLevel(contextUsage.used, contextUsage.limit) : 'normal';

  return (
    <div class="page project-detail">
      <header class="header">
        <a href="/" class="btn-icon header-circle-btn" title="Back to project list">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </a>
        {/* Invisible spacer to keep title centered on desktop, balancing the extra right-side button */}
        <div class="desktop-only header-spacer" aria-hidden="true" />
        <div class="header-info">
          <h1 class="header-title-btn" onClick={() => { setShowProjectMenu(true); setConfirmDelete(false); }}>{project.name}</h1>
          {(contextUsage || gitBranch) && (
            <div class="header-context mobile-only">
              <ContextBar contextUsage={contextUsage} gitBranch={gitBranch} state={project.state} />
            </div>
          )}
        </div>
        <button class="btn-icon header-circle-btn" onClick={() => setShowLinkPanel(!showLinkPanel)} title="Switch conversation">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <rect x="1" y="1" width="15" height="12" rx="2.5" />
            <path style={{ fill: 'var(--bg-primary)' }} d="M9.5 7H19.5A2.5 2.5 0 0122 9.5V16.5A2.5 2.5 0 0119.5 19H14L12 22V19H9.5A2.5 2.5 0 017 16.5V9.5A2.5 2.5 0 019.5 7Z" />
          </svg>
        </button>
        <button class="btn-icon header-circle-btn desktop-only" onClick={handleOpenFileBrowser} title="Browse files">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
      </header>

      <div class="mobile-only">
        {false && (contextUsage || gitBranch) && (
          <ContextBar contextUsage={contextUsage} gitBranch={gitBranch} state={project.state} />
        )}
      </div>

      <ConversationSwitcher
        projectId={id!}
        currentSessionId={project.claude_session_id}
        isOpen={showLinkPanel}
        onClose={() => setShowLinkPanel(false)}
        onSelect={handleLinkConversation}
      />

      {showProjectMenu && (
        <BottomSheet title={project.name} onClose={() => setShowProjectMenu(false)}>
          <div style={{ padding: '0 16px' }}>
            <div class="model-dropdown">
              <button
                class={`model-dropdown-trigger${showModelDropdown ? ' open' : ''}`}
                onClick={() => setShowModelDropdown(v => !v)}
              >
                <span class="model-dropdown-icon">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="4" y="4" width="16" height="16" rx="2" />
                    <rect x="8" y="8" width="8" height="8" rx="1" />
                    <line x1="12" y1="2" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="22" />
                    <line x1="2" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="22" y2="12" />
                  </svg>
                </span>
                <span class="model-dropdown-current">
                  {project.model ? project.model.charAt(0).toUpperCase() + project.model.slice(1) : 'Default'}
                </span>
                <svg class="model-dropdown-chevron" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {showModelDropdown && (
                <div class="model-dropdown-menu">
                  {([
                    { value: null, label: 'Default', desc: 'Claude が自動選択' },
                    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'バランス重視・1Mコンテキスト' },
                    { value: 'claude-opus-4-7[1m]', label: 'Opus 4.7', desc: '高精度・高負荷タスク向け・1Mコンテキスト' },
                  ] as { value: string | null; label: string; desc: string }[]).map(opt => {
                    const isActive = (project.model ?? null) === opt.value;
                    return (
                      <button
                        key={opt.label}
                        class={`model-dropdown-item${isActive ? ' active' : ''}`}
                        onClick={async () => {
                          try {
                            const updated = await api.updateProject(project.id, { model: opt.value });
                            setProject(updated);
                          } catch { /* ignore */ }
                          setShowModelDropdown(false);
                        }}
                      >
                        <span class="model-dropdown-item-text">
                          <span class="model-dropdown-item-label">{opt.label}</span>
                          <span class="model-dropdown-item-desc">{opt.desc}</span>
                        </span>
                        {isActive && (
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div style={{ marginTop: '16px' }}>
              <label class="team-mode-toggle">
                <span class="team-mode-toggle-text">
                  <span class="team-mode-toggle-label">Team モード</span>
                  <span class="team-mode-toggle-desc">
                    永続オーケストレータでチームを保持します（off にすると team は破棄）
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={!!project.team_mode}
                  onChange={async (e) => {
                    const next = (e.currentTarget as HTMLInputElement).checked;
                    try {
                      const updated = await api.updateProject(project.id, { teamMode: next });
                      setProject(updated);
                    } catch {
                      alert('Failed to update team mode');
                    }
                  }}
                />
                <span class="team-mode-toggle-switch" aria-hidden="true" />
              </label>
            </div>
            <div style={{ marginTop: '16px' }}>
              {confirmDelete ? (
                <div>
                  <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    Are you sure you want to delete this project?
                  </p>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button class="btn btn-danger" style={{ flex: 1 }} onClick={handleDeleteProject}>
                      Delete
                    </button>
                    <button class="btn" style={{ flex: 1 }} onClick={() => setConfirmDelete(false)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button class="btn btn-danger" style={{ width: '100%' }} onClick={() => setConfirmDelete(true)}>
                  Delete Project
                </button>
              )}
            </div>
          </div>
        </BottomSheet>
      )}

      <div
        class="project-detail-body"
        onTouchStart={(e) => {
          if (showFileBrowser) return;
          const t = e.touches[0];
          const panelWidth = Math.min(window.innerWidth, 500);
          // Cancel any in-flight snap animation so the new drag takes over
          if (drawerAnimCancelRef.current) {
            drawerAnimCancelRef.current();
            drawerAnimCancelRef.current = null;
          }
          drawerDragRef.current = {
            startX: t.clientX,
            startY: t.clientY,
            startTime: Date.now(),
            panelWidth,
            committed: false,
            target: e.target as Element,
          };
        }}
        onTouchMove={(e) => {
          const s = drawerDragRef.current;
          if (!s) return;
          const t = e.touches[0];
          const dx = t.clientX - s.startX;
          const dy = t.clientY - s.startY;
          if (!s.committed) {
            // Wait for small threshold then decide direction
            if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
            if (Math.abs(dy) > Math.abs(dx)) {
              // Vertical-dominant — let normal scroll happen
              drawerDragRef.current = null;
              return;
            }
            // Defer to a horizontally-scrollable ancestor if one can consume the drag
            const direction: 'left' | 'right' = dx < 0 ? 'left' : 'right';
            if (ancestorCanScrollHorizontally(s.target, direction, e.currentTarget as Element)) {
              drawerDragRef.current = null;
              return;
            }
            // Only leftward drags open the drawer
            if (dx >= 0) {
              drawerDragRef.current = null;
              return;
            }
            s.committed = true;
          }
          // Clamp: panel offscreen at panelWidth, fully visible at 0
          const offset = Math.max(0, Math.min(s.panelWidth, s.panelWidth + dx));
          setDrawerDragX(offset);
        }}
        onTouchEnd={(e) => {
          const s = drawerDragRef.current;
          if (!s) return;
          drawerDragRef.current = null;
          if (!s.committed) { setDrawerDragX(null); return; }
          const t = e.changedTouches[0];
          const dx = t.clientX - s.startX;
          const elapsed = Math.max(1, Date.now() - s.startTime);
          const velocity = -dx / elapsed; // px/ms, positive if leftward
          const shouldOpen = -dx > s.panelWidth * 0.35 || velocity > 0.5;
          const current = Math.max(0, Math.min(s.panelWidth, s.panelWidth + dx));
          const target = shouldOpen ? 0 : s.panelWidth;
          drawerAnimCancelRef.current = animateValue(
            current,
            target,
            200,
            (v) => setDrawerDragX(v),
            () => {
              drawerAnimCancelRef.current = null;
              setDrawerDragX(null);
              if (shouldOpen) setShowFileBrowser(true);
            }
          );
        }}
      >
        <LogViewer
              messages={chatMessages}
              loading={(!!pendingPrompt && !pendingFailed) || jobActive}
              loadingLabel={pendingPrompt ? 'Thinking...' : 'Running...'}
              projectId={id}
              onRetry={pendingFailed ? handleRetry : undefined}
              onDiscard={pendingFailed ? handleDiscard : undefined}
              onFileClick={(p) => setPreviewPath(p)}
            />
      </div>
      {id && (showFileBrowser || drawerDragX !== null) && (
        <FileBrowser
          projectId={id}
          open={showFileBrowser}
          dragOffset={drawerDragX}
          onClose={() => setShowFileBrowser(false)}
        />
      )}
      {id && previewPath && (
        <FilePreviewSheet
          projectId={id}
          filePath={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
      {id && team && selectedMember && (
        <TeamMemberSheet
          projectId={id}
          team={team}
          member={team.members.find((m) => m.name === selectedMember.name) || selectedMember}
          onClose={() => setSelectedMember(null)}
        />
      )}
      <TeamPanel
        team={team}
        loading={teamLoading}
        onMemberClick={(m) => setSelectedMember(m)}
        variant="floating"
      />
      <PromptInput
        projectId={id}
        onSubmit={handleRun}
        onCancel={handleCancel}
        disabled={isRunning}
        running={isRunning}
        driveSupported={driveMode.supported}
        driveActive={driveMode.state !== 'off'}
        onDriveToggle={driveMode.toggle}
      />

      {driveMode.state !== 'off' && (
        <div class="drive-overlay">
          <div class={`drive-indicator drive-${driveMode.state}`}>
            <div class="drive-pulse" />
            <span class="drive-label">
              {driveMode.state === 'listening' ? 'Listening...'
                : driveMode.state === 'processing' ? 'Thinking...'
                : 'Speaking...'}
            </span>
          </div>
          {driveMode.transcript && (
            <div class="drive-transcript">{driveMode.transcript}</div>
          )}
          {driveMode.currentSpeechText && (
            <div class="drive-assistant-text">{driveMode.currentSpeechText}</div>
          )}
          <button class="btn drive-stop-btn" onClick={driveMode.toggle}>
            Stop Drive Mode
          </button>
        </div>
      )}

      <aside class={`detail-sidebar context-${ctxLevel}`}>
        <div class="sidebar-card">
        <div class="sidebar-item">
          <svg class="sidebar-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span class={`state-badge state-${project.state.toLowerCase()}`}>
            {project.state}
          </span>
        </div>
        {(project.model || contextUsage?.model) && (
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
            <span class="sidebar-label">
              {project.model
                ? project.model.charAt(0).toUpperCase() + project.model.slice(1)
                : (contextUsage?.model || '').replace('claude-', '')}
            </span>
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
                {Math.round(contextUsage.used / 1000)}k ({contextPct}%)
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
        </div>
        <TeamPanel
          team={team}
          loading={teamLoading}
          onMemberClick={(m) => setSelectedMember(m)}
          variant="sidebar"
        />
      </aside>
    </div>
  );
}
