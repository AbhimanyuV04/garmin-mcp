/**
 * Google as the identity provider.
 *
 * Delegating sign-in means this server never stores a password, never runs a
 * reset flow, and never has to be trusted with one. A person's Google subject
 * claim becomes their user id, which is what keys their Garmin tokens.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export type GoogleIdentity = { sub: string; email: string };

/**
 * Secrets pasted into a dashboard routinely carry a trailing newline or stray
 * space. Google then rejects the credential as unknown, which surfaces as a
 * generic sign-in failure with nothing pointing at the real cause — so trim on
 * read rather than trusting the value to be clean.
 */
const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export function googleConfigured(): boolean {
  return Boolean(env('GOOGLE_CLIENT_ID') && env('GOOGLE_CLIENT_SECRET'));
}

export function requireGoogleConfig(): { clientId: string; clientSecret: string } {
  const clientId = env('GOOGLE_CLIENT_ID');
  const clientSecret = env('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.');
  }
  return { clientId, clientSecret };
}

export const googleRedirectUri = (issuer: string) => `${issuer}/auth/callback`;

export function googleAuthUrl(issuer: string, state: string): string {
  const { clientId } = requireGoogleConfig();
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', googleRedirectUri(issuer));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  // Always show the chooser: without it a shared browser silently reuses
  // whichever Google account signed in last, which on a family setup would
  // hand one person's Garmin data to another.
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

/**
 * Exchanges the callback code for an identity.
 *
 * The id_token's signature is deliberately not verified. Google documents that
 * a token received directly from its token endpoint over HTTPS, on a request
 * authenticated with the client secret, needs no signature check — the TLS
 * channel is the proof. Fetching JWKS would add a network dependency and a
 * cache to maintain for no gain here. The claims that carry meaning are still
 * checked below.
 */
export async function exchangeCode(issuer: string, code: string): Promise<GoogleIdentity> {
  const { clientId, clientSecret } = requireGoogleConfig();

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(issuer),
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) {
    throw new Error('Google rejected the sign-in. Try again.');
  }

  const body = (await response.json()) as { id_token?: string };
  if (!body.id_token) throw new Error('Google returned no id_token.');

  const parts = body.id_token.split('.');
  if (parts.length !== 3) throw new Error('Malformed id_token.');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
    iss?: string;
    aud?: string;
    sub?: string;
    email?: string;
    email_verified?: boolean;
    exp?: number;
  };

  // Confirms the token was minted for this app, not merely by Google.
  if (claims.aud !== clientId) throw new Error('id_token was issued for another app.');
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') {
    throw new Error('id_token has an unexpected issuer.');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('id_token has expired.');
  }
  // An unverified address can be claimed by someone who does not own it, which
  // matters because the allowlist is keyed on email.
  if (!claims.email || claims.email_verified !== true) {
    throw new Error('Google account has no verified email address.');
  }
  if (!claims.sub) throw new Error('id_token has no subject.');

  return { sub: claims.sub, email: claims.email.toLowerCase() };
}

/**
 * Who is allowed to use this deployment.
 *
 * Without this, anyone with a Google account could sign in and store their
 * Garmin credentials in your Redis — you would be running a free public health
 * data service and holding strangers' data. Fail closed when unset.
 */
export function isAllowed(email: string): boolean {
  const allowed = (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) return false;
  return allowed.includes(email.toLowerCase());
}

/** Google subs are digit strings; the prefix keeps ids readable in Redis. */
export const userIdFor = (identity: GoogleIdentity) => `google_${identity.sub}`;
