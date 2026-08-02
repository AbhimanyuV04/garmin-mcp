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

/** Issuer derived from the host actually reached, so previews work unchanged. */
export function issuerOf(req: Req): string {
  const host = header(req, 'host');
  if (!host) throw new Error('Missing Host header');
  const scheme = host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https';
  return `${scheme}://${host}`;
}

/** One shell for every server-rendered page so they read as one product. */
export function page(title: string, lead: string, body = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title>
<style>
:root{--bg:#fff;--fg:#16181d;--muted:#5c6270;--line:#d8dbe2;--accent:#1f6feb;
--err:#c0392b;--ok:#1a7f4b;--card:#f7f8fa}
@media(prefers-color-scheme:dark){:root{--bg:#14161a;--fg:#e8eaed;--muted:#9aa1ad;
--line:#2c3037;--accent:#5a9bff;--err:#ff8b7a;--ok:#5fd39b;--card:#1c1f24}}
*{box-sizing:border-box}
body{margin:0;padding:3rem 1rem;background:var(--bg);color:var(--fg);
font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:26rem;margin:0 auto}
h1{font-size:1.2rem;margin:0 0 .4rem}
p{color:var(--muted);margin:0 0 1.4rem}
p.fine{font-size:.8rem;margin:.9rem 0 0}
.err{color:var(--err)}.ok{color:var(--ok)}
label{display:block;font-weight:600;font-size:.875rem;margin-bottom:.3rem;color:var(--fg)}
input{width:100%;padding:.6rem .7rem;font:inherit;background:var(--bg);color:var(--fg);
border:1px solid var(--line);border-radius:6px;margin-bottom:1rem}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button,.btn{display:block;width:100%;text-align:center;text-decoration:none;
font:inherit;font-weight:600;padding:.65rem 1rem;border:0;border-radius:6px;
background:var(--accent);color:#fff;cursor:pointer}
.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;
padding:.8rem .9rem;margin-bottom:1.3rem;font-size:.875rem;color:var(--fg)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.8rem;
background:var(--card);padding:.15rem .35rem;border-radius:4px;word-break:break-all}
ol{padding-left:1.1rem;color:var(--muted)}li{margin-bottom:.5rem}
</style></head><body><main>
<h1>${esc(title)}</h1><p>${lead}</p>${body}
</main></body></html>`;
}
