// attachments.ts
// Bounded attachment pipeline for the chat composer.
//
// Replaces the old path that pushed full-size Base64 data URLs straight into
// state and the gateway payload (max count 4, no byte guard). That path risks
// memory spikes, HTTP 413 rejections, and OOM on large photos.
//
// Pipeline order per image:
//   validate MIME + input bytes -> decode via createImageBitmap (no full data
//   URL in memory) -> downscale on canvas (also strips EXIF/metadata, since
//   only pixels are redrawn) -> compress to JPEG/WebP Blob -> single data URL
//   encode only for the compressed output -> enforce per-image and total caps.
//
// Text files are never loaded fully: the file is sliced before reading, and
// truncation is always reported (ATTACH-03) with an include-all/summarize
// choice left to the caller.

export const MAX_IMAGE_COUNT = 4;
export const MAX_IMAGE_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_PROCESSED_IMAGE_BYTES = 1_500_000;
export const MAX_TOTAL_IMAGE_PAYLOAD_BYTES = 4_500_000;
export const MAX_IMAGE_DIM_PX = 1536;
export const IMAGE_PRIMARY_QUALITY = 0.82;
export const IMAGE_FALLBACK_QUALITY = 0.6;
export const MAX_TEXT_FILE_BYTES = 512 * 1024;
export const MAX_TEXT_INCLUDE_CHARS = 20000;

export const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

const TEXT_EXT_RE = /\.(txt|md|markdown|csv|json)$/i;

export type AttachmentKind = 'image' | 'text';

export interface FileMeta {
  name: string;
  type: string;
  size: number;
}

export interface ProcessedImage {
  dataUrl: string;
  mime: 'image/jpeg' | 'image/webp';
  bytes: number;
  width: number;
  height: number;
  sourceName: string;
  sourceBytes: number;
}

export type TextIncludeMode = 'full' | 'truncated';

export interface TextFileResult {
  fileName: string;
  fileBytes: number;
  includedChars: number;
  omittedChars: number;
  mode: TextIncludeMode;
  block: string;
}

export interface BatchOptions {
  imageCountAlreadyAttached?: number;
  /** Compressed payload bytes already staged, so the total cap accumulates across batches. */
  imagePayloadBytesAlreadyAttached?: number;
  textMaxChars?: number;
  allowTextIncludeAll?: boolean;
  signal?: AbortSignal;
}

export interface BatchResult {
  images: ProcessedImage[];
  texts: TextFileResult[];
  errors: string[];
}

export class AttachmentError extends Error {
  readonly userMessage: string;
  constructor(userMessage: string) {
    super(userMessage);
    this.name = 'AttachmentError';
    this.userMessage = userMessage;
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 2 : 1)} MB`;
}

export function describeFile(file: FileMeta): {
  kind: AttachmentKind | 'unsupported';
  name: string;
  mime: string;
  size: number;
} {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/')) {
    return { kind: 'image', name: file.name, mime, size: file.size };
  }
  if (
    TEXT_EXT_RE.test(file.name) ||
    mime.startsWith('text/') ||
    mime === 'application/json'
  ) {
    return { kind: 'text', name: file.name, mime, size: file.size };
  }
  return { kind: 'unsupported', name: file.name, mime, size: file.size };
}

export function validateImageFile(file: File): { ok: true } | { ok: false; reason: string } {
  const mime = (file.type || '').toLowerCase();
  if (!(ALLOWED_IMAGE_MIMES as readonly string[]).includes(mime)) {
    return {
      ok: false,
      reason: `Unsupported image type: ${file.name} (JPEG, PNG, WebP, GIF only)`,
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, reason: `Empty file: ${file.name}` };
  }
  if (file.size > MAX_IMAGE_INPUT_BYTES) {
    return {
      ok: false,
      reason: `${file.name} is ${formatBytes(file.size)} (limit ${formatBytes(MAX_IMAGE_INPUT_BYTES)})`,
    };
  }
  return { ok: true };
}

export function validateTextFile(file: File): { ok: true } | { ok: false; reason: string } {
  const desc = describeFile({ name: file.name, type: file.type, size: file.size });
  if (desc.kind !== 'text') {
    return {
      ok: false,
      reason: `Unsupported file type: ${file.name} (images and .txt/.md/.markdown/.csv/.json only)`,
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, reason: `Empty file: ${file.name}` };
  }
  if (file.size > MAX_TEXT_FILE_BYTES) {
    return {
      ok: false,
      reason: `${file.name} is ${formatBytes(file.size)} (text limit ${formatBytes(MAX_TEXT_FILE_BYTES)})`,
    };
  }
  return { ok: true };
}

export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const len = b64.length - (b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0);
  return Math.floor(len * 0.75);
}

export function totalPayloadBytes(dataUrls: string[]): number {
  return dataUrls.reduce((sum, u) => sum + estimateDataUrlBytes(u), 0);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AttachmentError('Attachment processing cancelled');
  }
}

async function decodeBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('decode failed'));
      el.src = url;
    });
    if (typeof createImageBitmap === 'function') {
      return createImageBitmap(img);
    }
    throw new Error('Image decoding is not supported on this browser');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fitDims(w: number, h: number, maxSide: number): { width: number; height: number } {
  const longest = Math.max(w, h);
  if (longest <= maxSide || longest <= 0) return { width: w, height: h };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  mime: 'image/jpeg' | 'image/webp',
  quality: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('encode failed'));
      },
      mime,
      quality
    );
  });
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

const dataUrlCache = new WeakMap<Blob, Promise<string>>();

function blobToDataUrlCached(blob: Blob): Promise<string> {
  const hit = dataUrlCache.get(blob);
  if (hit) return hit;
  const p = blobToDataUrl(blob);
  dataUrlCache.set(blob, p);
  return p;
}

export async function processImageFile(file: File, signal?: AbortSignal): Promise<ProcessedImage> {
  const check = validateImageFile(file);
  if (!check.ok) throw new AttachmentError(check.reason);
  throwIfAborted(signal);

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await decodeBitmap(file);
    throwIfAborted(signal);
    const { width, height } = fitDims(bitmap.width, bitmap.height, MAX_IMAGE_DIM_PX);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new AttachmentError(`Could not process image: ${file.name}`);
    ctx.drawImage(bitmap, 0, 0, width, height);

    const mime: 'image/jpeg' | 'image/webp' =
      (file.type || '').toLowerCase() === 'image/webp' ? 'image/webp' : 'image/jpeg';
    let blob = await canvasToBlob(canvas, mime, IMAGE_PRIMARY_QUALITY);
    if (blob.size > MAX_PROCESSED_IMAGE_BYTES) {
      blob = await canvasToBlob(canvas, mime, IMAGE_FALLBACK_QUALITY);
    }
    if (blob.size > MAX_PROCESSED_IMAGE_BYTES) {
      throw new AttachmentError(
        `${file.name} is still ${formatBytes(blob.size)} after compression (limit ${formatBytes(MAX_PROCESSED_IMAGE_BYTES)})`
      );
    }
    throwIfAborted(signal);
    const dataUrl = await blobToDataUrlCached(blob);
    return {
      dataUrl,
      mime,
      bytes: blob.size,
      width,
      height,
      sourceName: file.name,
      sourceBytes: file.size,
    };
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw new AttachmentError(`Could not read image: ${file.name}`);
  } finally {
    try {
      bitmap?.close();
    } catch {
      /* ignore */
    }
  }
}

// Read only the prefix needed for the char cap. Assumes mostly single byte
// text; the byte window oversamples 4x so multibyte text still fills the cap
// without ever loading the whole file.
async function readTextPrefix(file: File, maxChars: number): Promise<{ head: string; approxTotalChars: number }> {
  const windowBytes = Math.min(file.size, Math.max(4096, maxChars * 4 + 256));
  const headBuf = await file.slice(0, windowBytes).arrayBuffer();
  const head = new TextDecoder('utf-8', { fatal: false }).decode(headBuf);
  let approxTotalChars = head.length;
  if (file.size > windowBytes && windowBytes > 0) {
    approxTotalChars = Math.round((head.length / windowBytes) * file.size);
  }
  return { head, approxTotalChars };
}

export async function processTextFile(
  file: File,
  opts: { maxChars?: number; includeAll?: boolean; signal?: AbortSignal } = {}
): Promise<TextFileResult> {
  const check = validateTextFile(file);
  if (!check.ok) throw new AttachmentError(check.reason);
  const maxChars = opts.maxChars ?? MAX_TEXT_INCLUDE_CHARS;
  throwIfAborted(opts.signal);

  if (opts.includeAll) {
    const buf = await file.arrayBuffer();
    throwIfAborted(opts.signal);
    const raw = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    return {
      fileName: file.name,
      fileBytes: file.size,
      includedChars: raw.length,
      omittedChars: 0,
      mode: 'full',
      block: `--- ${file.name} (${formatBytes(file.size)}, full) ---\n${raw}`,
    };
  }

  const { head, approxTotalChars } = await readTextPrefix(file, maxChars);
  throwIfAborted(opts.signal);
  if (head.length <= maxChars) {
    return {
      fileName: file.name,
      fileBytes: file.size,
      includedChars: head.length,
      omittedChars: 0,
      mode: 'full',
      block: `--- ${file.name} (${formatBytes(file.size)}, full) ---\n${head}`,
    };
  }
  const included = head.slice(0, maxChars);
  const omitted = Math.max(0, approxTotalChars - maxChars);
  return {
    fileName: file.name,
    fileBytes: file.size,
    includedChars: included.length,
    omittedChars: omitted,
    mode: 'truncated',
    block:
      `--- ${file.name} (${formatBytes(file.size)}, showing ${included.length} of ~${approxTotalChars} chars) ---\n` +
      `${included}\n[truncated ${omitted} chars: choose include-all or summarize]`,
  };
}

export function buildTextChoiceNotice(results: TextFileResult[]): string | null {
  const cut = results.filter((r) => r.mode === 'truncated');
  if (cut.length === 0) return null;
  return cut
    .map((r) => `${r.fileName}: included ${r.includedChars}, omitted ~${r.omittedChars}`)
    .join('\n');
}

export async function processAttachBatch(
  files: File[] | FileList | null | undefined,
  opts: BatchOptions = {}
): Promise<BatchResult> {
  const out: BatchResult = { images: [], texts: [], errors: [] };
  if (!files) return out;
  const list: File[] = Array.from(files as ArrayLike<File>);
  if (list.length === 0) return out;

  const textMaxChars = opts.textMaxChars ?? MAX_TEXT_INCLUDE_CHARS;
  let imageSlots = Math.max(0, MAX_IMAGE_COUNT - (opts.imageCountAlreadyAttached ?? 0));

  for (const file of list) {
    if (opts.signal?.aborted) {
      out.errors.push('Attachment processing cancelled');
      break;
    }
    if (!file) continue;
    const desc = describeFile({ name: file.name, type: file.type, size: file.size });
    try {
      if (desc.kind === 'image') {
        if (imageSlots <= 0) {
          out.errors.push(`Image limit reached (${MAX_IMAGE_COUNT}): skipped ${file.name}`);
          continue;
        }
        const img = await processImageFile(file, opts.signal);
        const running =
          (opts.imagePayloadBytesAlreadyAttached ?? 0) +
          totalPayloadBytes([...out.images.map((i) => i.dataUrl), img.dataUrl]);
        if (running > MAX_TOTAL_IMAGE_PAYLOAD_BYTES) {
          out.errors.push(
            `${file.name} would exceed the total image payload cap (${formatBytes(MAX_TOTAL_IMAGE_PAYLOAD_BYTES)})`
          );
          continue;
        }
        out.images.push(img);
        imageSlots -= 1;
      } else if (desc.kind === 'text') {
        const text = await processTextFile(file, {
          maxChars: textMaxChars,
          includeAll: opts.allowTextIncludeAll,
          signal: opts.signal,
        });
        out.texts.push(text);
      } else {
        out.errors.push(`Unsupported file type: ${file.name} (images and .txt/.md/.csv/.json only)`);
      }
    } catch (e) {
      out.errors.push(e instanceof AttachmentError ? e.userMessage : `Could not read file: ${file.name}`);
    }
  }
  return out;
}
