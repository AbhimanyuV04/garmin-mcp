# Deploying the remote MCP server

Turns this into a hosted connector for Claude web and mobile: one URL, a Google
sign-in, and your Garmin tools appear. Several people can share one deployment,
each linking their own Garmin account.

Deploying puts health data behind a public URL, and you become the operator
holding other people's Garmin tokens. If you only ever use Claude Desktop, the
local stdio setup in [README.md](README.md) is simpler and exposes nothing.

## Routes

| Public path | Handler | Purpose |
| --- | --- | --- |
| `/mcp` | `api/mcp.ts` | The MCP endpoint. This is the connector URL. |
| `/` and `/connect` | `api/connect.ts` | Sign in, link Garmin, get the connector URL |
| `/authorize` | `api/oauth/authorize.ts` | Authorization request from Claude |
| `/token` | `api/oauth/token.ts` | Code and refresh grants |
| `/register` | `api/oauth/register.ts` | Dynamic client registration |
| `/auth/callback` | `api/auth/callback.ts` | Google returns here; verifies identity |
| `/auth/resume` | `api/auth/resume.ts` | Continues back to a waiting MCP client |
| `/api/deposit` | `api/deposit.ts` | Stores Garmin tokens in Redis |
| `/.well-known/oauth-authorization-server` | `api/oauth/metadata.ts` | Endpoint discovery |
| `/.well-known/oauth-protected-resource` | `api/oauth/resource.ts` | Points Claude at the auth server |

All wired in `vercel.json`. Nothing to configure by hand.

## 1. Create an Upstash Redis database

Any region. Copy the **REST** URL and token from the console — the REST pair,
not the `redis://` connection string.

## 2. Create a Google OAuth client

At [console.cloud.google.com](https://console.cloud.google.com) → Credentials →
Create Credentials → OAuth client ID → **Web application**. Add this authorized
redirect URI:

```
https://YOUR-APP.vercel.app/auth/callback
```

Copy the client ID and secret. This server never sees or stores a password;
identity comes from Google, and a person's subject claim keys their Garmin
tokens.

## 3. Generate the signing secret

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))"
```

## 4. Set environment variables

Each is checked at runtime, and a missing or too-short value disables the
endpoint that needs it rather than silently weakening it.

| Variable | Required | Notes |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | yes | REST URL from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | yes | REST token from Upstash |
| `JWT_SECRET` | yes, 16+ | Signs MCP access tokens. Changing it revokes every session. |
| `GOOGLE_CLIENT_ID` | yes | From step 2 |
| `GOOGLE_CLIENT_SECRET` | yes | From step 2 |
| `ALLOWED_EMAILS` | see below | Comma-separated. Empty blocks everyone rather than allowing everyone. |
| `INVITE_CODES` | no | Comma-separated, 8+ chars each. Lets a group self-serve. |
| `MAX_USERS` | no | Caps invite redemptions. Defaults to 25; `unlimited` removes the ceiling. |
| `OPEN_SIGNUP` | no | `true` lets any verified Google account join. Off unless set. |

Access is closed by default. Pick one:

- **Just you, or a handful of people** — list the addresses in `ALLOWED_EMAILS`.
- **A group** — set `INVITE_CODES` and share
  `https://YOUR-APP.vercel.app/connect?invite=CODE`. Redemption is recorded per
  address, so the code is needed only once, and `MAX_USERS` caps how far a
  forwarded code can travel.
- **Public** — set `OPEN_SIGNUP=true`. You will hold 30-day Garmin tokens for
  strangers, including GPS traces of every run. `/connect` states plainly that
  the server is run by an individual, what linking stores, and how to remove it.

```bash
npx vercel env add JWT_SECRET production
npx vercel env add GOOGLE_CLIENT_ID production
npx vercel env add GOOGLE_CLIENT_SECRET production
npx vercel env add ALLOWED_EMAILS production
npx vercel env add UPSTASH_REDIS_REST_URL production
npx vercel env add UPSTASH_REDIS_REST_TOKEN production
```

## 5. Deploy

```bash
npx vercel deploy --prod
```

Check discovery works before going further:

```bash
curl https://YOUR-APP.vercel.app/.well-known/oauth-authorization-server
```

You should see JSON whose `issuer` matches your domain. If you get HTML, the
rewrites did not apply — redeploy after confirming `vercel.json` is committed.

## 6. Link your Garmin account

Open `https://YOUR-APP.vercel.app/connect`, continue with Google, then enter
your Garmin email and password on the linking form. The password is used once to
reach Garmin and never stored; only the resulting OAuth tokens are kept, keyed to
your Google identity.

Tokens expire after about 30 days. Repeat this step when tools start reporting
that Garmin rejected the session.

> Two-factor Garmin accounts are not supported — the underlying library cannot
> answer an MFA challenge.

## 7. Add the connector in Claude

Settings → Connectors → **Add custom connector**, then paste:

```
https://YOUR-APP.vercel.app/mcp
```

Claude registers itself, discovers the OAuth endpoints, and opens the sign-in
page. The 15 tools appear once the flow completes.

You can also add the connector before linking Garmin — the callback offers the
linking form in place and then continues back to the waiting client.

## 8. Test it

> Pull my Garmin daily summary and sleep for the last three days, then my
> current training status and VO2 max. Find my most recent run and break down
> its lap splits and time in heart rate zones. Tell me whether my training load
> justifies a hard session tomorrow.

That exercises health, training and activity tools in one pass, so a single
answer tells you the whole connector works.

## Operating notes

- **Access tokens last 1 hour**, refresh tokens 30 days and rotate on every use.
  A rotated token cannot be replayed.
- **Usage counts** — how many accounts are linked and how many people signed up
  are shown on the callback page, but only to addresses in `ALLOWED_EMAILS`.
- **Revoke everything** by changing `JWT_SECRET` and redeploying. To disconnect
  one person's Garmin, delete their `garmin:tokens:google_<sub>` key in Upstash;
  they can also remove their own with `DELETE /api/deposit`.
- **No scope enforcement yet.** A valid token can call the three write tools
  (`create_workout`, `update_activity`, `download_activity_file`) as well as the
  reads. The scopes are advertised but not checked.
- **Rate limiting covers sign-in only.** It is Redis-backed because serverless
  instances share no memory. `/api/deposit` requires a deposit token whose
  audience differs from an MCP access token, so a token that reads Garmin data
  cannot overwrite the stored login.
- **`public/robots.txt` disallows all crawlers.** The sign-in and linking pages
  should not be indexed. This also means your deployment contributes nothing to
  discovery — the repo is the funnel.
