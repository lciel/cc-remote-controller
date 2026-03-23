import { useState, useRef, useCallback, useEffect } from 'preact/hooks';
import { ImageAttachment } from '../api/rest';

interface ImagePreview {
  file: File;
  url: string;     // object URL for preview
  data: string;    // base64
  mediaType: string;
}

interface Props {
  projectId?: string;
  onSubmit: (prompt: string, images?: ImageAttachment[]) => void;
  onCancel?: () => void;
  disabled: boolean;
  running?: boolean;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:image/png;base64," prefix
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getDraftKey(projectId?: string) {
  return projectId ? `draft:${projectId}` : null;
}

export function PromptInput({ projectId, onSubmit, onCancel, disabled, running }: Props) {
  const draftKey = getDraftKey(projectId);
  const [value, setValue] = useState(() => {
    if (!draftKey) return '';
    return localStorage.getItem(draftKey) || '';
  });
  const [images, setImages] = useState<ImagePreview[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const handleFiles = async (files: FileList) => {
    // Copy to Array — FileList is a live reference that gets invalidated when input.value is cleared
    const fileArray = Array.from(files);
    const newImages: ImagePreview[] = [];
    for (const file of fileArray) {
      if (!file.type.startsWith('image/')) continue;
      const data = await readFileAsBase64(file);
      newImages.push({
        file,
        url: URL.createObjectURL(file),
        data,
        mediaType: file.type,
      });
    }
    setImages((prev) => [...prev, ...newImages]);
  };

  const handleFileChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      handleFiles(input.files);
      input.value = '';
    }
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      URL.revokeObjectURL(prev[index].url);
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    const attachments = images.length > 0
      ? images.map((img) => ({ data: img.data, mediaType: img.mediaType }))
      : undefined;
    onSubmit(trimmed || '(image attached)', attachments);
    setValue('');
    if (draftKey) localStorage.removeItem(draftKey);
    images.forEach((img) => URL.revokeObjectURL(img.url));
    setImages([]);
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
      imageFiles.forEach(f => dt.items.add(f));
      await handleFiles(dt.files);
    }
  };

  return (
    <div class="prompt-input-wrapper">
      {images.length > 0 && (
        <div class="image-previews">
          {images.map((img, i) => (
            <div key={i} class="image-preview-item">
              <img src={img.url} alt="" onClick={() => setLightboxSrc(img.url)} />
              <button class="image-remove-btn" onClick={() => removeImage(i)}>x</button>
            </div>
          ))}
        </div>
      )}
      <div class="prompt-input">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <button
          class="btn-icon image-attach-btn"
          onClick={() => fileInputRef.current?.click()}
          title="Attach image"
        >
          +
        </button>
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
            disabled={disabled || (!value.trim() && images.length === 0)}
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
