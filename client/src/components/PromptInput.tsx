import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { ImageAttachment } from '../api/rest';

interface AttachmentPreview {
  file: File;
  url?: string;       // object URL for image preview only
  data: string;       // base64
  mediaType: string;
  filename: string;
  isImage: boolean;
}

interface Props {
  projectId?: string;
  onSubmit: (prompt: string, images?: ImageAttachment[]) => void;
  onCancel?: () => void;
  disabled: boolean;
  running?: boolean;
  driveSupported?: boolean;
  driveActive?: boolean;
  onDriveToggle?: () => void;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:<mediatype>;base64," prefix
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getDraftKey(projectId?: string) {
  return projectId ? `draft:${projectId}` : null;
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

export function PromptInput({ projectId, onSubmit, onCancel, disabled, running, driveSupported, driveActive, onDriveToggle }: Props) {
  const draftKey = getDraftKey(projectId);
  const [value, setValue] = useState(() => {
    if (!draftKey) return '';
    return localStorage.getItem(draftKey) || '';
  });
  const [attachments, setAttachments] = useState<AttachmentPreview[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachWrapRef = useRef<HTMLDivElement>(null);

  const isDesktop = useCallback(() => window.innerWidth >= 768, []);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = parseInt(getComputedStyle(el).lineHeight) || 20;
    const maxLines = isDesktop() ? 12 : 6;
    const maxHeight = lineHeight * maxLines;
    const clamped = Math.min(el.scrollHeight, maxHeight);
    el.style.height = clamped + 'px';
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  // Restore textarea height when draft is loaded
  useEffect(() => { if (value) autoResize(); }, []);

  const handleFiles = async (files: FileList, mode: 'image' | 'file') => {
    // Copy to Array — FileList is a live reference that gets invalidated when input.value is cleared
    const fileArray = Array.from(files);
    const newAttachments: AttachmentPreview[] = [];
    for (const file of fileArray) {
      const isImage = file.type.startsWith('image/');
      // Defensive: image picker is already filtered via accept, but guard anyway
      if (mode === 'image' && !isImage) continue;
      const data = await readFileAsBase64(file);
      newAttachments.push({
        file,
        url: isImage ? URL.createObjectURL(file) : undefined,
        data,
        mediaType: file.type || 'application/octet-stream',
        filename: file.name,
        isImage,
      });
    }
    setAttachments((prev) => [...prev, ...newAttachments]);
  };

  const handleImageInputChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      handleFiles(input.files, 'image');
      input.value = '';
    }
  };

  const handleFileInputChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      handleFiles(input.files, 'file');
      input.value = '';
    }
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => {
      const target = prev[index];
      if (target?.url) URL.revokeObjectURL(target.url);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    const payload = attachments.length > 0
      ? attachments.map((a) => ({ data: a.data, mediaType: a.mediaType, filename: a.filename }))
      : undefined;
    const allImages = attachments.length > 0 && attachments.every((a) => a.isImage);
    const fallback = allImages ? '(image attached)' : '(file attached)';
    onSubmit(trimmed || fallback, payload);
    setValue('');
    if (draftKey) localStorage.removeItem(draftKey);
    attachments.forEach((a) => { if (a.url) URL.revokeObjectURL(a.url); });
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    // PC only: Enter to submit, Shift+Enter for newline
    if (!isDesktop()) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handlePaste = async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      imageFiles.forEach((f) => dt.items.add(f));
      await handleFiles(dt.files, 'image');
    }
  };

  // Outside-tap & escape closes the attach menu
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!attachWrapRef.current) return;
      if (!attachWrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    // Defer subscription so the click that opened the menu doesn't immediately close it
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDown);
      document.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const onPickImage = () => {
    setMenuOpen(false);
    imageInputRef.current?.click();
  };
  const onPickFile = () => {
    setMenuOpen(false);
    fileInputRef.current?.click();
  };

  return (
    <div class="prompt-input-wrapper">
      {attachments.length > 0 && (
        <div class="image-previews">
          {attachments.map((att, i) =>
            att.isImage && att.url ? (
              <div key={i} class="image-preview-item">
                <img src={att.url} alt="" onClick={() => setLightboxSrc(att.url!)} />
                <button class="image-remove-btn" onClick={() => removeAttachment(i)}>x</button>
              </div>
            ) : (
              <div key={i} class="attachment-chip" title={att.filename}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span class="attachment-chip-name">{att.filename}</span>
                <span class="attachment-chip-size">{formatBytes(att.file.size)}</span>
                <button class="image-remove-btn" onClick={() => removeAttachment(i)}>x</button>
              </div>
            )
          )}
        </div>
      )}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={handleImageInputChange}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />
      <textarea
        ref={textareaRef}
        class="input prompt-textarea"
        value={value}
        onInput={(e) => {
          const v = (e.target as HTMLTextAreaElement).value;
          setValue(v);
          if (draftKey) localStorage.setItem(draftKey, v);
          autoResize();
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="Enter prompt..."
        rows={1}
      />
      <div class="prompt-input">
        <div class="attach-wrap" ref={attachWrapRef}>
          <button
            class={`btn-icon image-attach-btn${menuOpen ? ' attach-open' : ''}`}
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="Attach"
          >
            +
          </button>
          {menuOpen && (
            <div class="attach-menu" role="menu">
              <button class="attach-menu-item" role="menuitem" onClick={onPickImage}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <span>画像</span>
              </button>
              <button class="attach-menu-item" role="menuitem" onClick={onPickFile}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span>ファイル</span>
              </button>
            </div>
          )}
        </div>
        {driveSupported && (
          <button
            class={`btn-icon drive-toggle-btn${driveActive ? ' drive-active' : ''}`}
            onClick={onDriveToggle}
            title="Drive mode"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="23" />
              <line x1="8" y1="23" x2="16" y2="23" />
            </svg>
          </button>
        )}
        {running ? (
          <button
            class="btn-icon stop-btn"
            onClick={onCancel}
            title="Stop"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            class="btn-icon send-btn"
            onClick={handleSubmit}
            disabled={disabled || (!value.trim() && attachments.length === 0)}
            title="Send"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        )}
      </div>
      {lightboxSrc && (
        <div class="lightbox-overlay" onClick={() => setLightboxSrc(null)}>
          <button class="lightbox-close" onClick={() => setLightboxSrc(null)}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
          <img src={lightboxSrc} alt="" class="lightbox-img" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
