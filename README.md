# dsh-auto-retry

Auto-retry for unfinished agent turns in DeepSeek Harness (DSH).

## What it does

- Listens to session events (DSH `session/event`, `turn/end` with `reason.kind === "error"`).
- Every 10 minutes (`setInterval`, 600000 ms) checks each live session for a pending error (network drop, 502, timeout, any API error).
- If found, sends `continue` into the chat via `agent.followup()` and restarts the turn.
- Retry counter per session in memory: max 30 consecutive attempts. After 30 it stops and posts `auto-retry: stopped after 30 attempts` into the chat.
- The counter resets on any successful completed turn.
- Never touches chats where the answer arrived in full (`reason.kind === "completed"`).
- Never retries errors containing `insufficient_quota` or `invalid_api_key`.

## Install

Local folder (from the plugin directory):

```
dsh plugin --profile web add C:\Users\79881\Desktop\dsh-auto-retry
```

or from GitHub after publishing:

```
dsh plugin --profile web add github:YOUR_NICK/dsh-auto-retry
```

If pnpm reports a build-scripts error (ERR_PNPM...), add the package under `allowBuilds` in `C:\Users\79881\.dsh\profiles\web\pnpm-workspace.yaml` and re-run the command. This plugin has no dependencies and no build scripts, so that should not be needed.

Then restart DSH (reload the `web` profile) and verify:

```
dsh plugin --profile web list
```

`dsh-auto-retry` must appear in the list with bundle status.

## Files

- `index.js` - plugin code (entry: `apply(ctx)`, injected service `agents`)
- `cordis.patch.yml` - bundle layer registering the plugin row in the profile roster
- `package.json` - manifest with `dsh.bundle.patch`

## Uninstall

```
dsh plugin --profile web remove dsh-auto-retry
```
