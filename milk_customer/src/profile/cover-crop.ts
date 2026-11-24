export const COVER_RATIO = 16 / 9;
export const MAX_COVER_BYTES = 2 * 1024 * 1024;
export const MAX_COVER_WIDTH = 1440;
export const COVER_MAX_ZOOM = 3;

export type ImageSize = { width: number; height: number };
export type CoverCrop = { x: number; y: number; zoom: number };
export const CENTERED_CROP: CoverCrop = { x: 0.5, y: 0.5, zoom: 1 };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Crop coordinates in pixels, with the same framing in the preview and upload. */
export function coverCropRect(size: ImageSize, crop: CoverCrop) {
  const frame = Math.floor(Math.min(size.width / 16, size.height / 9));
  if (!Number.isFinite(frame) || frame < 1) throw new Error('Choose a larger photo for your cover.');
  const units = Math.max(1, Math.floor(frame / clamp(crop.zoom, 1, COVER_MAX_ZOOM)));
  const width = units * 16;
  const height = units * 9;
  return {
    originX: clamp(Math.round(size.width * crop.x - width / 2), 0, size.width - width),
    originY: clamp(Math.round(size.height * crop.y - height / 2), 0, size.height - height),
    width,
    height,
  };
}

export function panCoverCrop(
  size: ImageSize,
  crop: CoverCrop,
  pixelsMovedX: number,
  pixelsMovedY: number,
  frameWidth: number,
): CoverCrop {
  const rect = coverCropRect(size, crop);
  const scale = rect.width / frameWidth;
  return {
    x:
      (clamp(rect.originX - pixelsMovedX * scale, 0, size.width - rect.width) + rect.width / 2) /
      size.width,
    y:
      (clamp(rect.originY - pixelsMovedY * scale, 0, size.height - rect.height) + rect.height / 2) /
      size.height,
    zoom: crop.zoom,
  };
}
