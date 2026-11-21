// Drag-and-drop contract between the slice editor / pads and the arranger.
// A slice travels as plain JSON so any drop target (or another tab) can read it.

export const SLICE_MIME = 'application/x-platter-slice';

export interface SliceDragPayload {
  sourceId: string;
  /** Seconds into the source. */
  start: number;
  end: number;
}

export function setSliceDrag(dt: DataTransfer, payload: SliceDragPayload, label: string): void {
  dt.setData(SLICE_MIME, JSON.stringify(payload));
  dt.setData('text/plain', label);
  dt.effectAllowed = 'copy';
}

/** Payload of a slice drag, or null when the drag is something else. During dragover browsers
 *  hide the data (only types are visible), so use `hasSliceDrag` there and read on drop. */
export function readSliceDrag(dt: DataTransfer | null): SliceDragPayload | null {
  if (!dt) return null;
  const raw = dt.getData(SLICE_MIME);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SliceDragPayload>;
    if (typeof v.sourceId !== 'string' || typeof v.start !== 'number' || typeof v.end !== 'number') return null;
    if (!Number.isFinite(v.start) || !Number.isFinite(v.end) || v.end <= v.start) return null;
    return { sourceId: v.sourceId, start: v.start, end: v.end };
  } catch {
    return null;
  }
}

/** True while a slice is being dragged over a target (types are readable during dragover). */
export function hasSliceDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(SLICE_MIME);
}
