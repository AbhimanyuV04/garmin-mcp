# Deploying the token extractor

The extractor is optional. `npm run auth` produces the identical
`GARMIN_TOKENS_BASE64` string locally and never sends your password to a third
party — prefer it whenever you can run Node. Deploy this only when you need to
mint tokens from a machine without a local toolchain.

## What it is

- `public/index.html` — a static form (access key, email, password)
- `api/token.ts` — one serverless function that logs into Garmin and returns
  the tokens in the HTTP response

Nothing is persisted: no database, no disk write, no credential logging. The
password exists in function memory for the duration of the request only.

## Deploy

1. **Generate an access key.** The endpoint refuses every request until this is
   set, so an unconfigured deployment cannot be used against anyone.

   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

2. **Deploy.**

   ```bash
   npx vercel deploy --prod
   ```

3. **Set the key**, then redeploy so it takes effect.

   ```bash
   npx vercel env add AUTH_GATE_SECRET production
   ```

4. Open the deployment, enter the access key plus your Garmin credentials, and
   copy the resulting `GARMIN_TOKENS_BASE64`.

## Before you leave it up

- **Take the deployment down when you're done.** It only needs to exist for the
  minute it takes to mint a token. `npx vercel remove <project>` when finished.
- **Two-factor accounts will not work.** The underlying library cannot answer an
  MFA challenge; the endpoint returns a clear message telling you to use the
  local CLI instead.
- **There is no rate limiting.** Serverless functions have no shared memory, so
  a counter would need Redis or similar. The access key is what protects the
  endpoint — treat a leaked key as equivalent to leaving the page open to the
  internet, and rotate it by changing the env var.
- **The output is a credential.** The base64 blob grants full access to the
  Garmin account until the refresh token expires (roughly 30 days). Paste it
  into an env var or `~/.garmin-mcp/tokens.json`; don't put it in chat, a
  ticket, or a commit.

## Why the gate exists

A public URL that accepts an email and password and returns an account token is
structurally indistinguishable from a phishing page. The access key is what
makes this deployment *yours* rather than a service anyone can point a victim
at. That is also why the page carries no Garmin branding and states plainly
that it is unaffiliated: a user who lands on it should never mistake it for
Garmin's own login.
