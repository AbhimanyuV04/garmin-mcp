# garmin-mcp

[![npm](https://img.shields.io/npm/v/garmin-mcp)](https://www.npmjs.com/package/garmin-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Ask Claude about your Garmin data. Sleep, heart rate, stress, training load,
HRV and activities, plus a few writes — create a structured workout, edit an
activity, export a `.fit` file.

TypeScript, plain `node`. No Python, no `uvx`, no Docker.

```
> Find my most recent run, break down the lap splits and time in each heart
> rate zone, and tell me whether I paced it evenly or went out too fast.
```

## Quick start

```bash
npx garmin-mcp-auth
```

Prompts for your Garmin email and password, exchanges them for OAuth tokens,
and writes `~/.garmin-mcp/tokens.json` with `0600` permissions. Your password is
never stored. Tokens last about 30 days, then you re-run this.

Then add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "garmin-mcp"]
    }
  }
}
```

Restart Claude Desktop. The tools appear under the plug icon.

| OS | Config path |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

Also reachable from **Settings → Developer → Edit Config**. Create the file if
it doesn't exist.

> Garmin accounts with two-factor authentication are not supported — the
> underlying library cannot answer an MFA challenge.

## Try it

Four prompts that exercise the whole suite end to end:

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

**Strength**
> Show every set from my last gym session with reps and weight, then build me a
> workout for next time: 3x8 barbell bench press at 2.5 kg more than I lifted,
> resting until I press lap between sets.

## Tools

**Health** — `get_sleep_data`, `get_heart_rate`, `get_body_battery`,
`get_stress_and_respiration`, `get_daily_summary`, `get_body_composition`

**Training** — `get_training_status`, `get_hrv_data`, `get_cycling_metrics`,
`get_training_plans_and_workouts`, `create_workout`

**Activities** — `list_activities`, `get_activity_details`, `update_activity`,
`download_activity_file`

`create_workout`, `update_activity` and `download_activity_file` are marked as
writes, so Claude Desktop asks before running them.

Strength workouts check each exercise against a copy of Garmin's exercise
catalog in `src/tools/exercise-catalog.ts`, because Garmin silently blanks a
code it doesn't recognise. When Garmin adds exercises, save
<https://connect.garmin.com/web-data/exercises/Exercises.json> from a browser and
run `node scripts/refresh-exercise-catalog.mjs path/to/Exercises.json`.

### What your device actually reports

Garmin answers `200` with empty data for metrics your watch doesn't record,
rather than an error. Body battery and HRV in particular come back empty on
devices that don't measure them — the tools say so explicitly instead of
returning a confident-looking zero.

## Token in the environment instead of a file

For machines where you'd rather not leave a token file, or where the server runs
somewhere without your home directory. Use the `GARMIN_TOKENS_BASE64` value
printed by `npx garmin-mcp-auth`.

```json
{
  "mcpServers": {
    "garmin": {
      "command": "npx",
      "args": ["-y", "garmin-mcp"],
      "env": {
        "GARMIN_TOKENS_BASE64": "eyJvYXV0aDEiOnsi..."
      }
    }
  }
}
```

The environment variable wins when both are present, so this overrides a cached
file rather than racing it. Note that anything in this block sits in a plaintext
config file, and the token grants full account access until it expires — the
token file is the better default.

## If it doesn't connect

- **Check `node` is on the GUI PATH.** Claude Desktop launches with a minimal
  environment, not your shell's. If `node` isn't found, use its full path
  (`which node` on macOS, `where node` on Windows).
- **Re-run `npx garmin-mcp-auth`** if tools report that Garmin rejected the
  session. Tokens expire after about 30 days.
- **Running from a clone?** Use an absolute path to `dist/stdio.js`, not a
  relative one — Claude Desktop does not run the server from your project
  directory — and run `npm run build` first.

## Remote mode

The same tools can run as a hosted connector for Claude web and mobile: a Vercel
deployment with an OAuth 2.1 authorization server, Google sign-in, and Garmin
tokens in Upstash Redis. Add one URL in Claude, sign in, and the tools appear.
Supports multiple people on one deployment, each with their own Garmin account.

Local stdio stays the simpler option and exposes nothing to the internet. See
[DEPLOY.md](DEPLOY.md) for the hosted setup and its trade-offs.

## Development

```bash
git clone https://github.com/AbhimanyuV04/garmin-mcp.git
cd garmin-mcp
npm install
npm run build   # compile server and serverless handler
npm test        # build, then run the assert-based checks
```

Tokens live at `~/.garmin-mcp/tokens.json`, overridable with
`GARMIN_TOKEN_PATH`. See [.env.example](.env.example) for the full list of
variables.

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with or endorsed by Garmin. Uses the unofficial
[garmin-connect](https://www.npmjs.com/package/garmin-connect) library, which
talks to the same private API the Garmin Connect app uses.
