export type JsonRecord = Record<string, unknown>;

export const OUTCOMES = ['YES', 'NO'] as const;

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const normalized = Number.isFinite(value) ? value : 0;
  return Math.round(normalized * factor) / factor;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as JsonRecord;
}

export function safeNumber(value: unknown, fallback = 0): number {
  const parsed = toFiniteNumberOrNull(value);
  return parsed ?? fallback;
}

export function toFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function parseBooleanLoose(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }
  }

  return fallback;
}

export function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }

  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((entry) => String(entry));
      }
    } catch {
      return [];
    }
  }

  return [];
}

export function normalizeTimestampString(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function sanitizeConditionIds(values: readonly string[]): string[] {
  const unique = new Set<string>();

  for (const value of values) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
      continue;
    }

    unique.add(normalized);
  }

  return [...unique];
}

export function pruneMapEntries<TKey, TValue>(
  map: Map<TKey, TValue>,
  maxSize: number,
  deleteCount = Math.max(1, Math.ceil(maxSize / 4))
): void {
  if (map.size <= maxSize) {
    return;
  }

  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= deleteCount || map.size <= maxSize) {
      break;
    }
  }
}

export function pruneSetEntries<T>(
  set: Set<T>,
  maxSize: number,
  deleteCount = Math.max(1, Math.ceil(maxSize / 4))
): void {
  if (set.size <= maxSize) {
    return;
  }

  let removed = 0;
  for (const value of set.values()) {
    set.delete(value);
    removed += 1;
    if (removed >= deleteCount || set.size <= maxSize) {
      break;
    }
  }
}

export function formatLogTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatDayKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function sanitizeInlineText(value: string): string {
  return String(value || '').replace(/[\r\n"]/g, ' ').trim();
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}
