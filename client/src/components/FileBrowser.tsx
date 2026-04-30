import { useState, useEffect, useRef } from 'preact/hooks';
import { api, FileItem } from '../api/rest';
import { FilePreviewSheet } from './FilePreviewSheet';

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
  initialFile?: string | null;
  /** External drag offset in px (from the right edge of the panel). null = no external drag. */
  dragOffset?: number | null;
}

/**
 * In-memory cache for directory listings. Survives FileBrowser unmount/remount
 * but is wiped on page reload. Invalidated per-project when a conversation runs.
 */
const fileListCache = new Map<string, { items: FileItem[]; current: string }>();
const cacheKey = (projectId: string, path: string) => `${projectId} ${path}`;

export function invalidateFileListCache(projectId?: string): void {
  if (!projectId) { fileListCache.clear(); return; }
  const prefix = `${projectId} `;
  for (const k of Array.from(fileListCache.keys())) {
    if (k.startsWith(prefix)) fileListCache.delete(k);
  }
}

/** Animate a numeric value from `from` to `to` with easeOutCubic. Returns cancel fn. */
function animateValue(from: number, to: number, duration: number, onUpdate: (v: number) => void, onDone: () => void): () => void {
  const start = performance.now();
  let rafId = 0;
  let cancelled = false;
  const tick = (now: number) => {
    if (cancelled) return;
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - t, 3);
    onUpdate(from + (to - from) * eased);
    if (t < 1) rafId = requestAnimationFrame(tick);
    else onDone();
  };
  rafId = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(rafId); };
}

// ---- File type classification ----

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg']);
const CODE_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx',
  'cs', 'php', 'scala', 'sh', 'bash', 'zsh', 'fish',
  'lua', 'pl', 'r', 'dart', 'ex', 'exs', 'clj', 'elm',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte',
  'sql', 'graphql', 'proto',
]);
const CONFIG_EXTS = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'env', 'xml', 'conf', 'config']);
const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'org']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
const PDF_EXTS = new Set(['pdf']);

type FileKind = 'image' | 'code' | 'config' | 'doc' | 'audio' | 'video' | 'archive' | 'pdf' | 'other';

function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.substring(i + 1).toLowerCase() : '';
}

function kindOf(name: string): FileKind {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (CODE_EXTS.has(ext)) return 'code';
  if (CONFIG_EXTS.has(ext)) return 'config';
  if (DOC_EXTS.has(ext)) return 'doc';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (PDF_EXTS.has(ext)) return 'pdf';
  return 'other';
}

function FileTypeIcon({ kind }: { kind: FileKind | 'dir' }) {
  const common = { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' as const, 'stroke-linejoin': 'round' as const };
  switch (kind) {
    case 'dir':
      return (
        <svg {...common}>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      );
    case 'code':
      return (
        <svg {...common}>
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
      );
    case 'config':
      return (
        <svg {...common}>
          <path d="M8 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3" />
          <path d="M8 7h8M8 12h8M8 17h5" />
        </svg>
      );
    case 'doc':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="8" y1="13" x2="16" y2="13" />
          <line x1="8" y1="17" x2="14" y2="17" />
        </svg>
      );
    case 'image':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
      );
    case 'audio':
      return (
        <svg {...common}>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
      );
    case 'video':
      return (
        <svg {...common}>
          <rect x="2" y="6" width="20" height="12" rx="2" />
          <polygon points="10 9 16 12 10 15 10 9" fill="currentColor" />
        </svg>
      );
    case 'archive':
      return (
        <svg {...common}>
          <path d="M21 8v13H3V8" />
          <rect x="1" y="3" width="22" height="5" />
          <line x1="10" y1="12" x2="14" y2="12" />
        </svg>
      );
    case 'pdf':
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <text x="7" y="18" font-size="6" font-weight="700" stroke="none" fill="currentColor">PDF</text>
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      );
  }
}

// ---- Thumbnail blob cache (shared across FileBrowser lifetimes) ----
const thumbCache = new Map<string, string>(); // key: `${projectId} ${path}` → blobUrl
const thumbInFlight = new Map<string, Promise<string>>(); // prevent duplicate fetches

function getAuthToken(): string {
  return localStorage.getItem('cc-auth-token') || '';
}

async function fetchThumbBlobUrl(projectId: string, relPath: string): Promise<string> {
  const key = `${projectId} ${relPath}`;
  const cached = thumbCache.get(key);
  if (cached) return cached;
  const inflight = thumbInFlight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const res = await fetch(`/api/projects/${projectId}/file-raw?path=${encodeURIComponent(relPath)}`, {
      headers: { Authorization: `Bearer ${getAuthToken()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    thumbCache.set(key, url);
    thumbInFlight.delete(key);
    return url;
  })();
  thumbInFlight.set(key, p);
  return p;
}

/** Thumbnail for image files. Lazy-loads via IntersectionObserver. */
function Thumbnail({ projectId, filePath, fallbackKind }: { projectId: string; filePath: string; fallbackKind: FileKind }) {
  const [blobUrl, setBlobUrl] = useState<string | null>(thumbCache.get(`${projectId} ${filePath}`) ?? null);
  const [errored, setErrored] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (blobUrl || errored) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      // Fallback: fetch immediately
      fetchThumbBlobUrl(projectId, filePath).then(setBlobUrl).catch(() => setErrored(true));
      return;
    }
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          io.disconnect();
          fetchThumbBlobUrl(projectId, filePath)
            .then((u) => { if (!cancelled) setBlobUrl(u); })
            .catch(() => { if (!cancelled) setErrored(true); });
          return;
        }
      }
    }, { rootMargin: '200px' });
    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [projectId, filePath, blobUrl, errored]);

  if (errored) return <FileTypeIcon kind={fallbackKind} />;
  return (
    <div ref={ref} class="file-browser-thumb-wrap">
      {blobUrl ? <img src={blobUrl} class="file-browser-thumb" loading="lazy" /> : null}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatMtime(mtime: number): string {
  if (!mtime) return '';
  const d = new Date(mtime);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'たった今';
  if (diffMin < 60) return `${diffMin}分前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}時間前`;
  const sameYear = d.getFullYear() === now.getFullYear();
  const mm = d.getMonth() + 1;
  const dd = d.getDate();
  if (sameYear) return `${mm}月${dd}日`;
  return `${d.getFullYear()}年${mm}月${dd}日`;
}

/** Split a relative path into breadcrumb segments. Root is represented as ''. */
function breadcrumbSegments(relPath: string): { label: string; path: string }[] {
  const segs: { label: string; path: string }[] = [{ label: '/', path: '' }];
  if (!relPath) return segs;
  const parts = relPath.split('/').filter(Boolean);
  let acc = '';
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    segs.push({ label: p, path: acc });
  }
  return segs;
}

export function FileBrowser({ projectId, open, onClose, initialFile, dragOffset }: Props) {
  // Initial path: parent of initialFile, or '' for the project root
  const initialPath = initialFile
    ? (initialFile.includes('/') ? initialFile.substring(0, initialFile.lastIndexOf('/')) : '')
    : '';
  const initialCached = fileListCache.get(cacheKey(projectId, initialPath));

  const [currentPath, setCurrentPath] = useState<string>(initialCached?.current ?? initialPath);
  const [items, setItems] = useState<FileItem[]>(initialCached?.items ?? []);
  const [loading, setLoading] = useState<boolean>(!initialCached);
  const [previewPath, setPreviewPath] = useState<string | null>(initialFile ?? null);
  const [error, setError] = useState('');

  // Internal close-drag state (user drags panel rightward to dismiss)
  const [closeDragX, setCloseDragX] = useState<number | null>(null);
  const closeDragRef = useRef<{ startX: number; startY: number; startTime: number; panelWidth: number; committed: boolean } | null>(null);
  const closeAnimCancelRef = useRef<(() => void) | null>(null);

  // Back-key integration: push a history entry while the drawer is open, so the
  // Android/browser back button dismisses the drawer instead of navigating.
  const closedByBackRef = useRef(false);
  const animateCloseRef = useRef<() => void>(() => {});
  // Unique ID per instance so the handler can distinguish our marker from a
  // leftover {fileBrowser:true} entry that a prior instance couldn't clean up
  // in time (e.g. when the user reopens the drawer before an async history.back
  // has settled).
  const instanceIdRef = useRef<string>(Math.random().toString(36).slice(2));

  const loadDir = (relPath: string) => {
    const key = cacheKey(projectId, relPath);
    const cached = fileListCache.get(key);
    if (cached) {
      setCurrentPath(cached.current);
      setItems(cached.items);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    api.listFiles(projectId, relPath || undefined).then((res) => {
      fileListCache.set(cacheKey(projectId, relPath), { items: res.items, current: res.current });
      setCurrentPath(res.current);
      setItems(res.items);
    }).catch((e) => {
      setError(e.message || 'Failed to load');
    }).finally(() => setLoading(false));
  };

  // Fetch on mount (even during drag, so content is ready by the time the panel settles).
  // Re-fetches when initialFile changes (deep link from outside).
  useEffect(() => {
    if (initialFile) {
      const parent = initialFile.includes('/') ? initialFile.substring(0, initialFile.lastIndexOf('/')) : '';
      loadDir(parent);
      setPreviewPath(initialFile);
    } else {
      loadDir(currentPath);
    }
  }, [initialFile]);

  const handleItemClick = (item: FileItem) => {
    if (item.type === 'dir') {
      loadDir(item.path);
    } else {
      setPreviewPath(item.path);
    }
  };

  // Animated close triggered by overlay tap or header X button.
  // Slides the panel offscreen via closeDragX, then calls onClose to unmount.
  const animateClose = () => {
    if (closeAnimCancelRef.current) {
      closeAnimCancelRef.current();
      closeAnimCancelRef.current = null;
    }
    const panelWidth = Math.min(window.innerWidth, 500);
    const from = closeDragX != null ? closeDragX : 0;
    closeAnimCancelRef.current = animateValue(
      from,
      panelWidth,
      200,
      (v) => setCloseDragX(v),
      () => {
        closeAnimCancelRef.current = null;
        onClose();
      }
    );
  };
  animateCloseRef.current = animateClose;

  // Push a history entry while the drawer is open so the back key closes it.
  // The popstate handler only closes when OUR specific marker (by instance ID)
  // has been popped — distinguishing a genuine back press from:
  //   a) a deeper overlay (BottomSheet) being dismissed, which leaves our
  //      marker on top.
  //   b) a leftover marker from a previous instance that couldn't be cleaned
  //      up in time (async history.back() race with a rapid reopen).
  useEffect(() => {
    if (!open) return;
    const myId = instanceIdRef.current;
    history.pushState({ fileBrowser: true, fileBrowserId: myId }, '');
    const handler = () => {
      // If our specific marker is still on top, we're not the one being popped.
      if (history.state?.fileBrowserId === myId) return;
      closedByBackRef.current = true;
      animateCloseRef.current();
    };
    window.addEventListener('popstate', handler);
    return () => {
      window.removeEventListener('popstate', handler);
      // Normal close path (X / overlay / drag): pop the entry we pushed so the
      // stack stays balanced. Guard on our own ID to avoid popping an entry we
      // don't own.
      if (!closedByBackRef.current && history.state?.fileBrowserId === myId) {
        history.back();
      }
      closedByBackRef.current = false;
    };
  }, [open]);

  if (!open && dragOffset == null) return null;

  // Compute live transform (external open-drag wins over internal close-drag)
  const activeOffset = dragOffset != null ? dragOffset : closeDragX;
  const panelStyle = activeOffset != null
    ? { transform: `translate3d(${activeOffset}px, 0, 0)`, animation: 'none', transition: 'none' }
    : undefined;

  // Progress: 0 = fully closed/offscreen, 1 = fully open. Drives overlay blur/dim intensity.
  const panelWidth = Math.min(window.innerWidth, 500);
  const progress = activeOffset != null
    ? Math.max(0, Math.min(1, 1 - activeOffset / panelWidth))
    : 1;
  const overlayStyle = activeOffset != null
    ? {
        background: `rgba(0, 0, 0, ${progress * 0.1})`,
        backdropFilter: `blur(${progress * 8}px)`,
        WebkitBackdropFilter: `blur(${progress * 8}px)`,
        animation: 'none',
      }
    : undefined;

  const crumbs = breadcrumbSegments(currentPath);

  return (
    <>
      <div class="file-browser-overlay" style={overlayStyle} onClick={animateClose}>
        <div
          class="file-browser-panel"
          style={panelStyle}
          onClick={(e) => e.stopPropagation()}
          onTouchStart={(e) => {
            if (dragOffset != null) return; // external drag owns the panel
            if (!open) return;
            const t = e.touches[0];
            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
            // Cancel any in-flight snap animation so the new drag takes over
            if (closeAnimCancelRef.current) {
              closeAnimCancelRef.current();
              closeAnimCancelRef.current = null;
            }
            closeDragRef.current = {
              startX: t.clientX,
              startY: t.clientY,
              startTime: Date.now(),
              panelWidth: rect.width,
              committed: false,
            };
          }}
          onTouchMove={(e) => {
            const s = closeDragRef.current;
            if (!s) return;
            const t = e.touches[0];
            const dx = t.clientX - s.startX;
            const dy = t.clientY - s.startY;
            if (!s.committed) {
              if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
              // Only commit to horizontal-rightward drags
              if (Math.abs(dy) > Math.abs(dx) || dx < 0) {
                closeDragRef.current = null;
                return;
              }
              s.committed = true;
            }
            const offset = Math.max(0, Math.min(s.panelWidth, dx));
            setCloseDragX(offset);
          }}
          onTouchEnd={(e) => {
            const s = closeDragRef.current;
            if (!s) return;
            closeDragRef.current = null;
            if (!s.committed) { setCloseDragX(null); return; }
            const t = e.changedTouches[0];
            const dx = t.clientX - s.startX;
            const elapsed = Math.max(1, Date.now() - s.startTime);
            const velocity = dx / elapsed;
            const shouldClose = dx > s.panelWidth * 0.35 || velocity > 0.5;
            const current = Math.max(0, Math.min(s.panelWidth, dx));
            const target = shouldClose ? s.panelWidth : 0;
            closeAnimCancelRef.current = animateValue(
              current,
              target,
              200,
              (v) => setCloseDragX(v),
              () => {
                closeAnimCancelRef.current = null;
                setCloseDragX(null);
                if (shouldClose) onClose();
              }
            );
          }}
        >
          <header class="file-browser-header">
            <button class="btn-icon header-circle-btn file-browser-close" onClick={animateClose} aria-label="Close">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
            <nav class="file-browser-breadcrumb" aria-label="breadcrumb">
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                return (
                  <>
                    {i > 0 && <span class="file-browser-breadcrumb-sep" aria-hidden="true">›</span>}
                    {isLast ? (
                      <span class="file-browser-breadcrumb-item is-current">{c.label}</span>
                    ) : (
                      <button
                        class="file-browser-breadcrumb-item"
                        onClick={() => loadDir(c.path)}
                      >
                        {c.label}
                      </button>
                    )}
                  </>
                );
              })}
            </nav>
          </header>

          <div class="file-browser-body">
            {error && <div class="file-browser-error">{error}</div>}
            {loading ? (
              <div class="file-browser-empty">Loading...</div>
            ) : items.length === 0 ? (
              <div class="file-browser-empty">Empty directory</div>
            ) : (
              <div class="file-browser-list">
                {items.map((item) => {
                  const kind: FileKind | 'dir' = item.type === 'dir' ? 'dir' : kindOf(item.name);
                  const showThumb = kind === 'image';
                  return (
                    <button
                      key={item.path}
                      class={`file-browser-item file-browser-${item.type} file-browser-kind-${kind}`}
                      onClick={() => handleItemClick(item)}
                    >
                      <span class="file-browser-icon">
                        {showThumb
                          ? <Thumbnail projectId={projectId} filePath={item.path} fallbackKind="image" />
                          : <FileTypeIcon kind={kind} />}
                      </span>
                      <span class="file-browser-item-text">
                        <span class="file-browser-name">{item.name}{item.type === 'dir' ? '/' : ''}</span>
                        <span class="file-browser-item-meta">
                          {item.type === 'file' && item.size > 0 && (
                            <span class="file-browser-item-size">{formatSize(item.size)}</span>
                          )}
                          {item.type === 'file' && item.size > 0 && item.mtime > 0 && (
                            <span class="file-browser-item-dot">·</span>
                          )}
                          {item.mtime > 0 && (
                            <span class="file-browser-item-time">{formatMtime(item.mtime)}</span>
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {previewPath && (
        <FilePreviewSheet
          projectId={projectId}
          filePath={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </>
  );
}
