# garmin-mcp

An MCP server that gives Claude read access to your Garmin Connect data —
sleep, heart rate, stress, training load, HRV, activities — plus a small number
of writes (create a structured workout, edit an activity, export a file).

TypeScript, plain `node`. No `uvx`, no Python, no Docker.

## Setup

```bash
npm install
npm run auth     # one-time Garmin login; caches tokens
npm run build
```

`npm run auth` prompts for your Garmin email and password, exchanges them for
OAuth tokens, and writes `~/.garmin-mcp/tokens.json` with `0600` permissions.
Your password is never stored. The tokens last roughly 30 days, after which you
re-run the command.

> Accounts with two-factor authentication are not supported — the underlying
> library cannot answer an MFA challenge.

## Connecting Claude Desktop

Find `claude_desktop_config.json`:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |

You can also reach it from Claude Desktop: **Settings → Developer → Edit
Config**. Create the file if it doesn't exist.

### Option A — cached token file (recommended)

Nothing secret goes in the config; the server reads `~/.garmin-mcp/tokens.json`.

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["C:\\Users\\abhim\\Documents\\garmin-mcp\\dist\\stdio.js"]
    }
  }
}
```

On macOS the path is plain, with no escaping:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["/Users/you/garmin-mcp/dist/stdio.js"]
    }
  }
}
```

### Option B — token string in the environment

For machines where you'd rather not leave a token file, or where the server runs
somewhere without your home directory. Use the `GARMIN_TOKENS_BASE64` value
printed by `npm run auth`.

```json
{
  "mcpServers": {
    "garmin": {
      "command": "node",
      "args": ["C:\\Users\\abhim\\Documents\\garmin-mcp\\dist\\stdio.js"],
      "env": {
        "GARMIN_TOKENS_BASE64": "eyJvYXV0aDEiOnsi..."
      }
    }
  }
}
```

The environment variable wins when both are present, so Option B overrides a
cached file rather than racing it. Note that anything in this block sits in a
plaintext config file — the token grants full account access until it expires,
so Option A is the better default.

Restart Claude Desktop after editing. The tools appear under the plug icon.

### If it doesn't connect

- **Use an absolute path.** Claude Desktop does not run the server from your
  project directory, so a relative path won't resolve.
- **Run `npm run build` first.** The config points at `dist/stdio.js`, not the
  TypeScript source.
- **Check `node` is on the GUI PATH.** Claude Desktop launches with a minimal
  environment, not your shell's. If `node` isn't found, use its full path
  (`where node` on Windows, `which node` on macOS).
- **Re-run `npm run auth`** if tools report that Garmin rejected the session.

## Try it

Three prompts that exercise the whole suite end to end:

**Health**
> Pull my sleep and resting heart rate for the last five days, along with daily
> steps and stress. Is my resting heart rate trending up, and does it line up
> with the nights I slept badly?

**Training**
> What's my current training status, VO2 max and fitness age? Compare my weekly
> training load against my load target range and tell me whether to push harder
> or back off this week.

**Activity**
> Find my most recent run, break down the lap splits and time in each heart rate
> zone, and tell me whether I paced it evenly or went out too fast.

## Tools

**Health** — `get_sleep_data`, `get_heart_rate`, `get_body_battery`,
`get_stress_and_respiration`, `get_daily_summary`, `get_body_composition`

**Training** — `get_training_status`, `get_hrv_data`, `get_cycling_metrics`,
`get_training_plans_and_workouts`, `create_workout`

**Activities** — `list_activities`, `get_activity_details`, `update_activity`,
`download_activity_file`

`create_workout`, `update_activity` and `download_activity_file` are marked as
writes, so Claude Desktop will ask before running them.

### What your device actually reports

Garmin answers `200` with empty data for metrics your watch doesn't record,
rather than an error. On this account, body battery and HRV come back empty on
every date checked — the tools say so explicitly instead of returning a
confident-looking zero.

## Development

```bash
npm run build   # compile server and serverless handler
npm test        # build, then run the assert-based checks
```

Tokens live at `~/.garmin-mcp/tokens.json`, overridable with
`GARMIN_TOKEN_PATH`. See `.env.example` for the full list of variables.

## Remote mode

The same tools can run as a hosted connector for Claude Web: a Vercel
deployment with an OAuth 2.1 authorization server and Garmin tokens in Upstash
Redis. Add one URL in Claude, log in, and the tools appear.

Local stdio stays the simpler option and exposes nothing to the internet. See
[DEPLOY.md](DEPLOY.md) for the hosted setup and its trade-offs.
