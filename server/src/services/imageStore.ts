import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const UPLOAD_DIR = '/tmp/cc-uploads';

export interface ImageAttachment {
  data: string;       // base64-encoded
  mediaType: string;  // e.g. "image/png" or "application/pdf"
  filename?: string;  // original filename (used for extension when mediaType is unknown)
}

function ensureDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function extFromMediaType(mediaType: string): string | null {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  };
  return map[mediaType] || null;
}

function pickExtension(att: ImageAttachment): string {
  // Prefer the original filename's extension when present (path.basename guards against traversal).
  if (att.filename) {
    const safe = path.basename(att.filename);
    const ext = path.extname(safe).toLowerCase();
    if (ext && /^\.[a-z0-9]{1,16}$/.test(ext)) return ext;
  }
  return extFromMediaType(att.mediaType) || '.bin';
}

export function saveImages(images: ImageAttachment[]): string[] {
  ensureDir();
  const paths: string[] = [];
  for (const img of images) {
    const ext = pickExtension(img);
    const filename = `${crypto.randomUUID()}${ext}`;
    const filePath = path.join(UPLOAD_DIR, filename);
    fs.writeFileSync(filePath, Buffer.from(img.data, 'base64'));
    paths.push(filePath);
  }
  return paths;
}

export function cleanupImages(paths: string[]): void {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/** Remove all files in the upload directory (called on server startup) */
export function cleanupUploadDir(): void {
  try {
    if (!fs.existsSync(UPLOAD_DIR)) return;
    for (const file of fs.readdirSync(UPLOAD_DIR)) {
      try {
        fs.unlinkSync(path.join(UPLOAD_DIR, file));
      } catch {
        // Ignore per-file errors
      }
    }
  } catch {
    // Ignore errors
  }
}
