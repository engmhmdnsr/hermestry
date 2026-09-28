// attachmentRefs.ts
// Durable attachment references for chat history (ATTACH-02).
//
// History persistence must never store Base64 blobs: a few full-size photos
// would blow the localStorage quota and make every session load parse
// megabytes of data URLs. This module stores metadata only:
//
//   { id, type, name, mime, size, localRef }
//
// The binary lives outside the DB in a module scoped Blob registry keyed by
// localRef. Previews use short lived object URLs from that registry, not data
// URLs. After a reload the registry is empty by design; refs resolve to
// undefined and the UI renders them as unavailable instead of crashing.

import type { ProcessedImage, TextFileResult } from './attachments';

export type AttachmentRefType = 'image' | 'text';

export interface AttachmentRef {
  id: string;
  type: AttachmentRefType;
  name: string;
  mime: string;
  size: number;
  localRef: string;
  width?: number;
  height?: number;
  createdAt: number;
}

export interface RefPayload {
  images: string[];
  notice: string | null;
}

let refCounter = 0;

function newRefId(prefix: string): string {
  try {
    const uuid =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null;
    if (uuid) return `${prefix}_${uuid.slice(0, 8)}`;
  } catch {
    /* fall through */
  }
  refCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${refCounter}`;
}

const blobRegistry = new Map<string, Blob>();
const previewUrls = new Map<string, string>();

function storageKey(sessionId: string): string {
  return `hermes_attachments_${sessionId}`;
}

function isRefShape(v: unknown): v is AttachmentRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    (r.type === 'image' || r.type === 'text') &&
    typeof r.name === 'string' &&
    typeof r.mime === 'string' &&
    typeof r.size === 'number' &&
    typeof r.localRef === 'string'
  );
}

export function registerBlob(blob: Blob, meta: Omit<AttachmentRef, 'id' | 'localRef' | 'createdAt'>): AttachmentRef {
  const id = newRefId('att');
  const localRef = `blob:${id}`;
  const ref: AttachmentRef = { ...meta, id, localRef, createdAt: Date.now() };
  blobRegistry.set(localRef, blob);
  return ref;
}

export function refsFromProcessedImages(images: ProcessedImage[]): AttachmentRef[] {
  return images.map((img) => {
    const id = newRefId('att');
    const localRef = `blob:${id}`;
    return {
      id,
      type: 'image' as const,
      name: img.sourceName,
      mime: img.mime,
      size: img.bytes,
      localRef,
      width: img.width,
      height: img.height,
      createdAt: Date.now(),
    };
  });
}

export function refsFromTexts(texts: TextFileResult[]): AttachmentRef[] {
  return texts.map((t) => ({
    id: newRefId('att'),
    type: 'text' as const,
    name: t.fileName,
    mime: 'text/plain',
    size: t.fileBytes,
    localRef: `text:${newRefId('t')}`,
    createdAt: Date.now(),
  }));
}

export function resolveBlob(refOrKey: AttachmentRef | string): Blob | undefined {
  const key = typeof refOrKey === 'string' ? refOrKey : refOrKey.localRef;
  return blobRegistry.get(key);
}

export function isRefAvailable(refOrKey: AttachmentRef | string): boolean {
  const key = typeof refOrKey === 'string' ? refOrKey : refOrKey.localRef;
  if (blobRegistry.has(key)) return true;
  if (typeof refOrKey !== 'string' && refOrKey.type === 'text') return true;
  return false;
}

export function previewUrlFor(ref: AttachmentRef): string | undefined {
  const blob = blobRegistry.get(ref.localRef);
  if (!blob) return undefined;
  const hit = previewUrls.get(ref.localRef);
  if (hit) return hit;
  const url = URL.createObjectURL(blob);
  previewUrls.set(ref.localRef, url);
  return url;
}

export function revokeRef(refOrKey: AttachmentRef | string): void {
  const key = typeof refOrKey === 'string' ? refOrKey : refOrKey.localRef;
  const url = previewUrls.get(key);
  if (url) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
    previewUrls.delete(key);
  }
  blobRegistry.delete(key);
}

export function loadAttachmentRefs(sessionId: string): AttachmentRef[] {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRefShape).slice(-100);
  } catch {
    return [];
  }
}

export function saveAttachmentRefs(sessionId: string, refs: AttachmentRef[]): void {
  try {
    const slim = refs.slice(-100).map((r) => ({
      id: r.id,
      type: r.type,
      name: r.name,
      mime: r.mime,
      size: r.size,
      localRef: r.localRef,
      width: r.width,
      height: r.height,
      createdAt: r.createdAt,
    }));
    localStorage.setItem(storageKey(sessionId), JSON.stringify(slim));
  } catch {
    /* quota or privacy mode: refs stay memory only */
  }
}

export function appendAttachmentRefs(sessionId: string, refs: AttachmentRef[]): AttachmentRef[] {
  const prev = loadAttachmentRefs(sessionId);
  const seen = new Set(prev.map((r) => r.id));
  const next = [...prev, ...refs.filter((r) => !seen.has(r.id))].slice(-100);
  saveAttachmentRefs(sessionId, next);
  return next;
}

export function clearSessionRefs(sessionId: string, opts: { revokeBlobs?: boolean } = {}): void {
  if (opts.revokeBlobs) {
    for (const ref of loadAttachmentRefs(sessionId)) {
      if (ref.type === 'image') revokeRef(ref);
    }
  }
  try {
    localStorage.removeItem(storageKey(sessionId));
  } catch {
    /* ignore */
  }
}

// Strip any embedded data URLs before persisting chat bubbles. Keeps history
// small and avoids QuotaExceededError on sessions with photos.
export function stripDataUrlBlobs(text: string): string {
  if (!text || text.indexOf('data:') < 0) return text;
  return text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image omitted]');
}

export function summarizeRefsForSend(refs: AttachmentRef[]): string {
  if (refs.length === 0) return '';
  return refs
    .map((r) =>
      r.type === 'image'
        ? `[image ${r.name} ${r.width ?? '?'}x${r.height ?? '?'}]`
        : `[file ${r.name}]`
    )
    .join('\n');
}
