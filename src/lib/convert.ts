import MarkdownIt from 'markdown-it';
import sharp from 'sharp';

/**
 * Format conversion.
 *
 * THE CORE RULE: only the original bytes are ever stored. Every conversion
 * happens here, on read. Nothing in this file writes to the database.
 *
 * Why it matters: if you converted on write, you would have thrown away the
 * original. A user who uploads a PNG and later wants the PNG back would get
 * whatever you re-encoded it into. Conversions are lossy; originals are not
 * recoverable once discarded.
 */

const md = new MarkdownIt({ html: false, linkify: true });

export const TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/html',
  'application/json',
] as const;

export const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const;

export type SupportedType = (typeof TEXT_TYPES)[number] | (typeof IMAGE_TYPES)[number];

export function isSupportedType(type: string): type is SupportedType {
  return (
    (TEXT_TYPES as readonly string[]).includes(type) ||
    (IMAGE_TYPES as readonly string[]).includes(type)
  );
}

export function isImage(type: string): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(type);
}

/** URL extension -> media type. `/api/fragments/abc.html` -> 'text/html' */
export const EXT_TO_TYPE: Record<string, SupportedType> = {
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/**
 * What each source type is allowed to become.
 *
 * Note every type includes itself. Requesting `/abc.md` on a markdown fragment
 * must succeed, not 415 — asking for the format you already have is a valid
 * request, and it is the case people forget to allow.
 *
 * Note also what is NOT here: text/html does not convert to text/markdown.
 * Going HTML -> Markdown means guessing at intent and silently dropping any
 * markup Markdown cannot express. A conversion that quietly loses content is
 * worse than a 415 that tells the caller no.
 */
const CONVERSIONS: Record<SupportedType, SupportedType[]> = {
  'text/plain': ['text/plain'],
  'text/markdown': ['text/markdown', 'text/html', 'text/plain'],
  'text/html': ['text/html', 'text/plain'],
  'application/json': ['application/json', 'text/plain'],
  'image/png': [...IMAGE_TYPES],
  'image/jpeg': [...IMAGE_TYPES],
  'image/webp': [...IMAGE_TYPES],
  'image/gif': [...IMAGE_TYPES],
  'image/avif': [...IMAGE_TYPES],
};

export function canConvert(from: string, to: string): boolean {
  if (!isSupportedType(from) || !isSupportedType(to)) return false;
  return CONVERSIONS[from].includes(to);
}

export function validTargets(from: string): SupportedType[] {
  return isSupportedType(from) ? CONVERSIONS[from] : [];
}

/** sharp's format names don't always match the media subtype ('jpeg' not 'jpg'). */
const SHARP_FORMAT: Record<string, keyof sharp.FormatEnum> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/**
 * Convert `data` from one media type to another.
 * Throws if the conversion is not permitted — callers should check
 * `canConvert` first and return 415.
 */
export async function convert(
  data: Buffer,
  from: string,
  to: string
): Promise<{ data: Buffer; type: string }> {
  if (!canConvert(from, to)) {
    throw new Error(`Cannot convert ${from} to ${to}`);
  }

  // Identity conversion: return the original bytes untouched.
  //
  // This early return is load-bearing. Without it, an image "converted" to its
  // own format would still be round-tripped through sharp, which re-encodes and
  // silently degrades quality. The response would look correct — right status,
  // right Content-Type, a valid image — while being quietly worse than what was
  // uploaded. That is the failure mode this whole project is about.
  if (from === to) {
    return { data, type: to };
  }

  if (isImage(from)) {
    const out = await sharp(data).toFormat(SHARP_FORMAT[to]).toBuffer();
    return { data: out, type: to };
  }

  const text = data.toString('utf8');

  if (from === 'text/markdown' && to === 'text/html') {
    return { data: Buffer.from(md.render(text), 'utf8'), type: to };
  }

  // Any text-ish type -> text/plain is a pass-through of the raw characters.
  if (to === 'text/plain') {
    return { data: Buffer.from(text, 'utf8'), type: to };
  }

  throw new Error(`Unhandled conversion ${from} -> ${to}`);
}

/**
 * Splits a route param into an id and an optional extension.
 *
 *   'abc123'      -> { id: 'abc123', ext: null }
 *   'abc123.html' -> { id: 'abc123', ext: 'html' }
 *
 * Splits on the LAST dot, and only treats the suffix as an extension if it is
 * one we actually recognise. UUIDs don't contain dots, but ids that do would
 * otherwise be truncated — and a request for a fragment whose id happens to end
 * in '.foo' should 404, not silently resolve to a different fragment.
 */
export function parseIdAndExt(param: string): { id: string; ext: string | null } {
  const dot = param.lastIndexOf('.');
  if (dot <= 0) return { id: param, ext: null };

  const maybeExt = param.slice(dot + 1).toLowerCase();
  if (!(maybeExt in EXT_TO_TYPE)) return { id: param, ext: null };

  return { id: param.slice(0, dot), ext: maybeExt };
}
