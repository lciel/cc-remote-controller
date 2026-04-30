import { useState, useEffect } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api/rest';
import { BottomSheet } from './BottomSheet';
import { detectLang, highlightCode } from '../utils/codeHighlight';

const MARKDOWN_EXTS = new Set(['md', 'markdown']);

function isMarkdownPath(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  return MARKDOWN_EXTS.has(ext);
}

marked.setOptions({ breaks: true, gfm: true });

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string);
}

interface Props {
  projectId: string;
  filePath: string;
  onClose: () => void;
}

type MediaKind = 'image' | 'audio' | 'video' | 'text' | 'binary';

interface LoadedFile {
  size: number;
  kind: MediaKind;
  content: string | null;
  blobUrl: string | null;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov']);

function kindFromName(name: string): MediaKind {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return 'text';
}

function getAuthToken(): string {
  return localStorage.getItem('cc-auth-token') || '';
}

async function fetchAsBlobUrl(projectId: string, relPath: string): Promise<string> {
  const res = await fetch(`/api/projects/${projectId}/file-raw?path=${encodeURIComponent(relPath)}`, {
    headers: { Authorization: `Bearer ${getAuthToken()}` },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FilePreviewSheet({ projectId, filePath, onClose }: Props) {
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Markdown view mode: 'rendered' shows parsed HTML, 'plain' shows the source.
  // Reset to default whenever the previewed file changes.
  const [mdView, setMdView] = useState<'rendered' | 'plain'>('rendered');
  const [copied, setCopied] = useState(false);

  useEffect(() => { setMdView('rendered'); setCopied(false); }, [filePath]);

  const handleCopyAll = async () => {
    const text = loaded?.content;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  };

  useEffect(() => {
    let cancelled = false;
    let createdBlobUrl: string | null = null;

    const load = async () => {
      setLoading(true);
      setError('');
      const name = filePath.split('/').pop() || filePath;
      const kind = kindFromName(name);
      try {
        if (kind === 'image' || kind === 'audio' || kind === 'video') {
          const blobUrl = await fetchAsBlobUrl(projectId, filePath);
          createdBlobUrl = blobUrl;
          if (!cancelled) {
            setLoaded({ size: 0, kind, content: null, blobUrl });
          } else {
            URL.revokeObjectURL(blobUrl);
          }
        } else {
          const res = await api.readFile(projectId, filePath);
          if (!cancelled) {
            setLoaded({
              size: res.size,
              kind: res.binary ? 'binary' : 'text',
              content: res.content,
              blobUrl: null,
            });
          }
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Failed to read file');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl);
    };
  }, [projectId, filePath]);

  const title = filePath;

  const isText = loaded?.kind === 'text' && loaded?.content != null;
  const isMd = isText && isMarkdownPath(filePath);
  const showRenderedMd = isMd && mdView === 'rendered';

  return (
    <BottomSheet title={title} onClose={onClose}>
      <div class="file-preview-body">
        {(loaded?.size || isText) && (
          <div class="file-preview-toolbar">
            {loaded && loaded.size > 0 && (
              <span class="file-preview-size">{formatSize(loaded.size)}</span>
            )}
            <span class="file-preview-toolbar-spacer" />
            {isMd && (
              <div class="file-preview-mode" role="tablist" aria-label="View mode">
                <button
                  class={`file-preview-mode-btn${mdView === 'rendered' ? ' is-active' : ''}`}
                  onClick={() => setMdView('rendered')}
                  role="tab"
                  aria-selected={mdView === 'rendered'}
                >Rendered</button>
                <button
                  class={`file-preview-mode-btn${mdView === 'plain' ? ' is-active' : ''}`}
                  onClick={() => setMdView('plain')}
                  role="tab"
                  aria-selected={mdView === 'plain'}
                >Plain</button>
              </div>
            )}
            {isText && (
              <button
                class={`file-preview-copy-btn${copied ? ' is-copied' : ''}`}
                onClick={handleCopyAll}
                title="Copy file content"
                aria-label="Copy file content"
              >
                {copied ? (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            )}
          </div>
        )}
        {error && <div class="file-browser-error">{error}</div>}
        {loading ? (
          <div class="file-browser-empty">Loading...</div>
        ) : loaded ? (
          loaded.kind === 'image' && loaded.blobUrl ? (
            <div class="file-browser-media"><img src={loaded.blobUrl} alt={filePath} /></div>
          ) : loaded.kind === 'audio' && loaded.blobUrl ? (
            <div class="file-browser-media"><audio src={loaded.blobUrl} controls /></div>
          ) : loaded.kind === 'video' && loaded.blobUrl ? (
            <div class="file-browser-media"><video src={loaded.blobUrl} controls /></div>
          ) : loaded.kind === 'text' ? (
            showRenderedMd ? (
              <div
                class="file-preview-markdown chat-content"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(loaded.content!) }}
              />
            ) : (
              <pre class="file-preview-code">
                <code
                  class={`hljs${detectLang(filePath) ? ` language-${detectLang(filePath)}` : ''}`}
                  dangerouslySetInnerHTML={{ __html: highlightCode(loaded.content || '', isMd ? 'markdown' : detectLang(filePath)) }}
                />
              </pre>
            )
          ) : (
            <div class="file-browser-empty">Binary file — cannot display</div>
          )
        ) : null}
      </div>
    </BottomSheet>
  );
}
