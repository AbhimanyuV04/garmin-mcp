/**
 * Minimal structural types for Vercel's Node handlers, matching the approach in
 * api/token.ts: the platform supplies the real objects, and this keeps a
 * types-only dependency out of the tree.
 */
export type Req = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

export type Res = {
  setHeader(name: string, value: string): void;
  status(code: number): Res;
  json(body: unknown): unknown;
  send(body: string): unknown;
  end(): unknown;
};

export const header = (req: Req, name: string): string | undefined => {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

export function param(req: Req, name: string): string | undefined {
  const fromQuery = req.query?.[name];
  if (fromQuery !== undefined) return Array.isArray(fromQuery) ? fromQuery[0] : fromQuery;
  // Vercel does not populate `query` in every runtime; fall back to the URL.
  if (req.url) {
    const value = new URL(req.url, 'http://localhost').searchParams.get(name);
    if (value !== null) return value;
  }
  return undefined;
}

export function formField(req: Req, name: string): string | undefined {
  const body = req.body;
  if (body && typeof body === 'object') {
    const v = (body as Record<string, unknown>)[name];
    if (typeof v === 'string') return v;
  }
  if (typeof body === 'string') {
    const v = new URLSearchParams(body).get(name);
    if (v !== null) return v;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.[name] === 'string') return parsed[name];
    } catch {
      /* not JSON */
    }
  }
  return undefined;
}

/** OAuth responses carry credentials; keep every one of them out of caches. */
export function noStore(res: Res): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function oauthError(res: Res, status: number, error: string, description?: string) {
  noStore(res);
  return res.status(status).json({ error, error_description: description });
}

/** Escapes interpolation into HTML so a redirect_uri cannot inject markup. */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

export function html(res: Res, status: number, body: string) {
  noStore(res);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(status).send(body);
}
