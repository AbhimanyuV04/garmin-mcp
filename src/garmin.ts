import { GarminConnect } from 'garmin-connect';
import { GarminTokens, LOCAL_USER, loadTokens, saveTokens } from './db';

// Node's built-in .env loader (20.12+). MCP clients normally pass config via
// their own `env` block, so a missing file is the common case, not an error.
try {
  process.loadEnvFile();
} catch {
  /* no .env present */
}

const GC_API = 'https://connectapi.garmin.com';

export class GarminAuthError extends Error {}

/**
 * One user's authenticated view of Garmin.
 *
 * Deliberately NOT a module-level singleton. A hosted server handles many users
 * on one warm instance, and a shared client would serve whichever account
 * happened to log in first — leaking one person's health data to another.
 * Build one of these per request and let it fall out of scope.
 */
export class GarminSession {
  private profile?: Promise<{ displayName: string; profileId: number }>;
  private connecting?: Promise<GarminConnect>;

  private constructor(
    readonly userId: string,
    /** access_token as loaded, used to detect a background refresh. */
    private lastAccessToken: string | undefined,
    client?: GarminConnect
  ) {
    if (client) this.connecting = Promise.resolve(client);
  }

  /**
   * Resolves tokens on first use rather than up front.
   *
   * The HTTP transport wants this: a missing-token failure should surface as a
   * readable tool error after the client has connected, not as an opaque
   * handshake failure with nowhere to show the reason.
   */
  static forUser(userId: string): GarminSession {
    return new GarminSession(userId, undefined);
  }

  /** Eager variant: fails at startup, which is what stdio wants. */
  static async create(userId: string = LOCAL_USER): Promise<GarminSession> {
    const session = GarminSession.forUser(userId);
    await session.getClient();
    return session;
  }

  /** Builds a session from tokens already in hand, e.g. straight after login. */
  static fromTokens(userId: string, tokens: GarminTokens): GarminSession {
    const client = new GarminConnect({ username: '', password: '' });
    client.loadToken(tokens.oauth1, tokens.oauth2);
    return new GarminSession(userId, accessTokenOf(tokens), client);
  }

  private getClient(): Promise<GarminConnect> {
    this.connecting ??= (async () => {
      const tokens = await loadTokens(this.userId);
      if (!tokens) {
        throw new GarminAuthError(
          this.userId === LOCAL_USER
            ? 'No Garmin tokens found. Run `npm run auth` to sign in.'
            : 'No Garmin tokens stored for this account. Connect Garmin before using these tools.'
        );
      }
      this.lastAccessToken = accessTokenOf(tokens);
      const client = new GarminConnect({ username: '', password: '' });
      client.loadToken(tokens.oauth1, tokens.oauth2);
      return client;
    })();
    return this.connecting;
  }

  /**
   * The library's axios interceptor refreshes the oauth2 token in memory when
   * it expires. On a serverless instance that memory dies with the request, so
   * write the new token back or every cold start pays for a refresh.
   */
  private async persistIfRefreshed(client: GarminConnect): Promise<void> {
    try {
      const current = client.exportToken();
      const token = accessTokenOf(current);
      if (token && token !== this.lastAccessToken) {
        this.lastAccessToken = token;
        await saveTokens(this.userId, current);
      }
    } catch {
      // A failed write must not fail the user's actual request.
    }
  }

  async api<T>(path: string, params?: Record<string, string>): Promise<T> {
    const client = await this.getClient();
    const result = await client.client.get<T>(`${GC_API}${path}`, params ? { params } : undefined);
    await this.persistIfRefreshed(client);
    return result;
  }

  async apiPost<T>(path: string, body: unknown): Promise<T> {
    const client = await this.getClient();
    const result = await client.client.post<T>(`${GC_API}${path}`, body);
    await this.persistIfRefreshed(client);
    return result;
  }

  async apiPut<T>(path: string, body: unknown): Promise<T> {
    const client = await this.getClient();
    const result = await client.client.put<T>(`${GC_API}${path}`, body);
    await this.persistIfRefreshed(client);
    return result;
  }

  /** GET a binary payload (activity file exports) rather than JSON. */
  async apiDownload(path: string): Promise<Buffer> {
    const client = await this.getClient();
    const data = await client.client.get<ArrayBuffer>(`${GC_API}${path}`, {
      responseType: 'arraybuffer'
    });
    await this.persistIfRefreshed(client);
    return Buffer.from(data);
  }

  /** Memoized per session, never across users. */
  private getProfile() {
    this.profile ??= this.getClient()
      .then((c) => c.getUserProfile())
      .then((p) => ({ displayName: p.displayName, profileId: p.profileId as number }));
    return this.profile;
  }

  /** Several wellness endpoints are keyed by display name rather than user id. */
  async getDisplayName(): Promise<string> {
    return (await this.getProfile()).displayName;
  }

  /** Gear endpoints key off the numeric profile id, not the display name. */
  async getProfileId(): Promise<number> {
    return (await this.getProfile()).profileId;
  }

  /** Cheap authenticated call; confirms the stored tokens still work. */
  async verify(): Promise<boolean> {
    try {
      await this.getDisplayName();
      return true;
    } catch {
      return false;
    }
  }
}

function accessTokenOf(tokens: GarminTokens): string | undefined {
  return (tokens.oauth2 as { access_token?: string })?.access_token;
}
