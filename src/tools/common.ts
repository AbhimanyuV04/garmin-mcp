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
