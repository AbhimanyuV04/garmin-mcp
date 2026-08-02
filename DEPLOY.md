# Deploying the remote MCP server

Turns this into a hosted connector you can add to Claude Web: one URL, an OAuth
login, and your Garmin tools appear.

Deploying puts your health data behind a public URL. `ADMIN_PASSWORD` is the
only thing in front of it — use something long and random, not a password you
have used elsewhere. If you only ever use Claude Desktop, the local stdio setup
in [README.md](README.md) is simpler and exposes nothing.

## Routes

| Public path | Handler | Purpose |
| --- | --- | --- |
| `/mcp` | `api/mcp.ts` | The MCP endpoint. This is the connector URL. |
| `/authorize` | `api/oauth/authorize.ts` | Login page shown by Claude |
| `/login` | `api/oauth/login.ts` | Password check, issues the auth code |
| `/token` | `api/oauth/token.ts` | Code and refresh grants |
| `/register` | `api/oauth/register.ts` | Dynamic client registration |
| `/.well-known/oauth-authorization-server` | `api/oauth/metadata.ts` | Endpoint discovery |
| `/.well-known/oauth-protected-resource` | `api/oauth/resource.ts` | Points Claude at the auth server |
| `/api/deposit` | `api/deposit.ts` | Stores Garmin tokens in Redis |
| `/` | `public/index.html` | Deposit form |

All wired in `vercel.json`. Nothing to configure by hand.

## 1. Create an Upstash Redis database

Any region. Copy the **REST** URL and token from the console — the REST pair,
not the `redis://` connection string.

## 2. Generate secrets

```bash
node -e "console.log('JWT_SECRET=' + require('crypto').randomBytes(32).toString('base64url')); console.log('ADMIN_PASSWORD=' + require('crypto').randomBytes(24).toString('base64url')); console.log('AUTH_GATE_SECRET=' + require('crypto').randomBytes(24).toString('base64url'))"
```

## 3. Set environment variables

All four are required. Each one is checked at runtime, and a missing or
too-short value disables the endpoint that needs it rather than silently
weakening it.

| Variable | Required | Notes |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` | yes | REST URL from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | yes | REST token from Upstash |
| `JWT_SECRET` | yes, 16+ | Signs MCP access tokens. Changing it revokes every session. |
| `ADMIN_PASSWORD` | yes, 16+ | The OAuth login password. Rate limited to 8 tries per 15 min per IP. |
| `AUTH_GATE_SECRET` | yes, 16+ | Guards `/api/deposit`. Without it that endpoint refuses every request. |

```bash
npx vercel env add JWT_SECRET production
npx vercel env add ADMIN_PASSWORD production
npx vercel env add AUTH_GATE_SECRET production
npx vercel env add UPSTASH_REDIS_REST_URL production
npx vercel env add UPSTASH_REDIS_REST_TOKEN production
```

## 4. Deploy

```bash
npx vercel deploy --prod
```

Check discovery works before going further:

```bash
curl https://YOUR-APP.vercel.app/.well-known/oauth-authorization-server
```

You should see JSON whose `issuer` matches your domain. If you get HTML, the
rewrites did not apply — redeploy after confirming `vercel.json` is committed.

## 5. Deposit your Garmin tokens

Nothing works until Garmin tokens exist in Redis under the `owner` key. The
OAuth login deliberately refuses with "Garmin not connected" until they do,
rather than letting you connect to a server where every tool fails.

**Option A — the web form.** Open `https://YOUR-APP.vercel.app/`, enter your
`AUTH_GATE_SECRET` as the access key, then your Garmin email and password. On
success the response includes `"deposited": true`.

**Option B — from the CLI**, if you would rather your password not touch the
browser:

```bash
curl -X POST https://YOUR-APP.vercel.app/api/deposit -H "content-type: application/json" -H "x-auth-gate: YOUR_AUTH_GATE_SECRET" -d '{"email":"you@example.com","password":"YOUR_GARMIN_PASSWORD"}'
```

Either way the password is used once to reach Garmin and never stored. Tokens
expire after about 30 days; repeat this step when tools start reporting that
Garmin rejected the session.

> Two-factor Garmin accounts are not supported — the underlying library cannot
> answer an MFA challenge.

## 6. Add the connector in Claude

Settings → Connectors → **Add custom connector**, then paste:

```
https://YOUR-APP.vercel.app/mcp
```

Claude registers itself, discovers the OAuth endpoints, and opens the login
page. Enter your `ADMIN_PASSWORD` and approve. The 15 tools appear once the
flow completes.

## 7. Test it

> Pull my Garmin daily summary and sleep for the last three days, then my
> current training status and VO2 max. Find my most recent run and break down
> its lap splits and time in heart rate zones. Tell me whether my training load
> justifies a hard session tomorrow.

That exercises health, training and activity tools in one pass, so a single
answer tells you the whole connector works.

## Operating notes

- **Access tokens last 1 hour**, refresh tokens 30 days and rotate on every use.
  A rotated token cannot be replayed.
- **Revoke everything** by changing `JWT_SECRET` and redeploying. To disconnect
  Garmin specifically, delete the `garmin:tokens:owner` key in Upstash.
- **Single user.** Every login maps to `owner`. Adding real multi-user means
  replacing the password check with an identity provider and keying tokens by
  its subject claim; the storage layer already takes a user id throughout.
- **No scope enforcement yet.** A valid token can call the three write tools
  (`create_workout`, `update_activity`, `download_activity_file`) as well as the
  reads. The scopes are advertised but not checked.
- **Rate limiting covers the login only.** It is Redis-backed because serverless
  instances share no memory. `/api/deposit` is protected by the gate secret
  rather than a counter.
