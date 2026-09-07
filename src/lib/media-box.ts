/**
 * Media-box geometry (M7) — the object-contain math shared by the LLM cursor
 * overlay (normalized -> px) and the demonstration capture (px -> normalized).
 *
 * The stage renders its media (shared-screen <video>, managed-browser <img>)
 * with object-contain, so the element rect and the actually-displayed media
 * rect differ by letterboxing. All dual-cursor coordinates are normalized to
 * the DISPLAYED MEDIA BOX, never the element box — otherwise clicks land off
 * target on any non-matching aspect ratio.
 *
 * Pure: operates on a plain structural shape, importable by node --test.
 */

export interface MediaBoxSource {
  clientWidth: number;
  clientHeight: number;
  /** <video> intrinsic size */
  videoWidth?: number;
  videoHeight?: number;
  /** <img> intrinsic size */
  naturalWidth?: number;
  naturalHeight?: number;
}

export interface ElementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ContainRect {
  /** offsets of the displayed media box INSIDE the element (px) */
  x: number;
  y: number;
  w: number;
  h: number;
}

function intrinsicSize(src: MediaBoxSource): { w: number; h: number } | null {
  const w = src.videoWidth || src.naturalWidth || 0;
  const h = src.videoHeight || src.naturalHeight || 0;
  return w > 0 && h > 0 ? { w, h } : null;
}

/**
 * The displayed media box inside an object-contain element. Falls back to the
 * element box when intrinsic dimensions are unknown (e.g. headless capture on
 * a bare container) — coordinates stay self-consistent within one surface.
 */
export function containRect(src: MediaBoxSource): ContainRect {
  const elW = src.clientWidth;
  const elH = src.clientHeight;
  const intrinsic = intrinsicSize(src);
  if (!intrinsic || elW <= 0 || elH <= 0) return { x: 0, y: 0, w: elW, h: elH };
  const scale = Math.min(elW / intrinsic.w, elH / intrinsic.h);
  const w = intrinsic.w * scale;
  const h = intrinsic.h * scale;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}

/** Client (viewport) point -> normalized media-box coordinates, or null when outside. */
export function clientToNormalized(
  src: MediaBoxSource,
  rect: ElementRect,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const box = containRect(src);
  const px = clientX - rect.left - box.x;
  const py = clientY - rect.top - box.y;
  if (px < 0 || py < 0 || px > box.w || py > box.h) return null;
  if (box.w <= 0 || box.h <= 0) return null;
  return { x: px / box.w, y: py / box.h };
}

/** Normalized media-box coordinates -> client (viewport) point. */
export function normalizedToClient(
  src: MediaBoxSource,
  rect: ElementRect,
  nx: number,
  ny: number
): { x: number; y: number } {
  const box = containRect(src);
  const cx = clampUnit(nx);
  const cy = clampUnit(ny);
  return { x: rect.left + box.x + cx * box.w, y: rect.top + box.y + cy * box.h };
}

function clampUnit(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
