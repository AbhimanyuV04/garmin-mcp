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

  private constructor(
    readonly userId: string,
    private readonly client: GarminConnect,
    /** access_token as loaded, used to detect a background refresh. */
    private lastAccessToken: string | undefined
  ) {}

  static async create(userId: string = LOCAL_USER): Promise<GarminSession> {
    const tokens = await loadTokens(userId);
    if (!tokens) {
      throw new GarminAuthError(
        userId === LOCAL_USER
          ? 'No Garmin tokens found. Run `npm run auth` to sign in.'
          : `No Garmin tokens stored for this account. Connect Garmin before using these tools.`
      );
    }
    const client = new GarminConnect({ username: '', password: '' });
    client.loadToken(tokens.oauth1, tokens.oauth2);
    return new GarminSession(userId, client, accessTokenOf(tokens));
  }

  /** Builds a session from tokens already in hand, e.g. straight after login. */
  static fromTokens(userId: string, tokens: GarminTokens): GarminSession {
    const client = new GarminConnect({ username: '', password: '' });
    client.loadToken(tokens.oauth1, tokens.oauth2);
    return new GarminSession(userId, client, accessTokenOf(tokens));
  }

  /**
   * The library's axios interceptor refreshes the oauth2 token in memory when
   * it expires. On a serverless instance that memory dies with the request, so
   * write the new token back or every cold start pays for a refresh.
   */
  private async persistIfRefreshed(): Promise<void> {
    try {
      const current = this.client.exportToken();
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
    const result = await this.client.client.get<T>(
      `${GC_API}${path}`,
      params ? { params } : undefined
    );
    await this.persistIfRefreshed();
    return result;
  }

  async apiPost<T>(path: string, body: unknown): Promise<T> {
    const result = await this.client.client.post<T>(`${GC_API}${path}`, body);
    await this.persistIfRefreshed();
    return result;
  }

  async apiPut<T>(path: string, body: unknown): Promise<T> {
    const result = await this.client.client.put<T>(`${GC_API}${path}`, body);
    await this.persistIfRefreshed();
    return result;
  }

  /** GET a binary payload (activity file exports) rather than JSON. */
  async apiDownload(path: string): Promise<Buffer> {
    const data = await this.client.client.get<ArrayBuffer>(`${GC_API}${path}`, {
      responseType: 'arraybuffer'
    });
    await this.persistIfRefreshed();
    return Buffer.from(data);
  }

  /** Memoized per session, never across users. */
  private getProfile() {
    this.profile ??= this.client
      .getUserProfile()
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
