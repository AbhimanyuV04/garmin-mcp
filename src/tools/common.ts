import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** Local calendar date — Garmin days are local, so UTC would be off by a day. */
export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

export function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/** Garmin returns nulls for every metric the device didn't record; drop them. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  ) as Partial<T>;
}

export const round = (n: number, places = 1) => Number(n.toFixed(places));
export const hours = (seconds: number) => round(seconds / 3600, 2);
export const pct = (part: number, whole: number) =>
  whole > 0 ? round((part / whole) * 100) : undefined;

/**
 * Sleep timestamps arrive as epoch milliseconds. Garmin's `*Local` variants are
 * pre-shifted so that reading them as UTC yields local wall time, so the "Z"
 * from toISOString would be a lie — drop it and match the "YYYY-MM-DD HH:mm"
 * format the activity endpoints already use.
 */
export const localFromEpoch = (ms: number | null | undefined) =>
  typeof ms === 'number' && ms > 0
    ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
    : undefined;

/** Garmin floats carry binary noise (3.0999999046325684); trim on the way out. */
export const num = (n: unknown, places = 1) =>
  typeof n === 'number' && Number.isFinite(n) ? round(n, places) : undefined;

export const km = (meters: number | null | undefined) =>
  typeof meters === 'number' ? round(meters / 1000, 2) : undefined;

/** Garmin reports speed in m/s; runners read pace, cyclists read km/h. */
export const paceMinPerKm = (metersPerSecond: number | null | undefined) => {
  if (typeof metersPerSecond !== 'number' || metersPerSecond <= 0) return undefined;
  const totalMinutes = 1000 / metersPerSecond / 60;
  const minutes = Math.floor(totalMinutes);
  const seconds = Math.round((totalMinutes - minutes) * 60);
  // 4:60/km would be wrong; carry the rounded second into the minute.
  return seconds === 60 ? `${minutes + 1}:00` : `${minutes}:${String(seconds).padStart(2, '0')}`;
};

export const kmh = (metersPerSecond: number | null | undefined) =>
  typeof metersPerSecond === 'number' ? round(metersPerSecond * 3.6, 1) : undefined;

/** Seconds to h:mm:ss, dropping the hour when there isn't one. */
export const hms = (seconds: number | null | undefined) => {
  if (typeof seconds !== 'number') return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

export type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

export const text = (value: unknown): Result => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
});

export const problem = (message: string): Result => ({
  content: [{ type: 'text', text: message }],
  isError: true
});

/**
 * Some Garmin metrics endpoints nest their payload under an opaque device id.
 * There is only ever one entry that matters — the watch that recorded it.
 */
export function firstDeviceEntry<T = any>(byDevice: unknown): T | undefined {
  if (!byDevice || typeof byDevice !== 'object') return undefined;
  return Object.values(byDevice as Record<string, T>)[0];
}

/**
 * Registers a tool with uniform error handling: Garmin answers 404/204 for a
 * date the watch wasn't worn, which is a normal empty day rather than a fault.
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: S,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = { readOnlyHint: true }
): void {
  server.registerTool(name, { description, inputSchema, annotations }, (async (args: unknown) => {
    try {
      return await handler(args as z.infer<z.ZodObject<S>>);
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 204) {
        return problem('No data available from Garmin for that date.');
      }
      if (status === 401 || status === 403) {
        return problem('Garmin rejected the session. Re-run `npm run auth` to refresh tokens.');
      }
      if (status === 429) {
        return problem('Garmin is rate limiting this account. Wait a few minutes and retry.');
      }
      const message = err instanceof Error ? err.message : String(err);
      return problem(`Could not fetch ${name}: ${message}`);
    }
  }) as Parameters<McpServer['registerTool']>[2]);
}
