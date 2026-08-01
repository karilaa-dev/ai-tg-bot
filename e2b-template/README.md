# ai-tg-bot E2B toolbox

This directory defines the reusable, private `ai-tg-bot-tools` E2B template. It is based on E2B Base, uses 2 vCPU and 2 GiB RAM, and contains the command-line toolbox used by sandbox-backed agent work. Browser work remains in Camofox; this template intentionally has no Chromium or browser automation bundle.

## Build and promote

Set `E2B_API_KEY` in the ignored root `.env`, then run:

```sh
npm run e2b:template:build
```

The command builds a unique immutable tag, creates a temporary validation sandbox, runs the complete contract, checks internet access and pause/resume persistence, deletes the validation sandbox, and only then moves `ai-tg-bot-tools:production` to the passing build. Bot startup never rebuilds the template.

Validate the current production tag without rebuilding it:

```sh
npm run e2b:template:check
```

To roll back, use E2B's tag API to assign `production` to a previously validated build tag. Existing thread sandboxes keep their original filesystem and build until they are deleted; tag changes affect newly created sandboxes only.

## Legacy Desktop cleanup

Stop the bot first. Preview the exact cleanup scope, then execute it:

```sh
npm run e2b:sandboxes:prune-desktop
npm run e2b:sandboxes:prune-desktop -- --execute
```

The command only matches E2B sandboxes whose template name is `desktop` and whose metadata contains `app=ai-tg-bot`. Deleted workspace and process state cannot be recovered; Telegram-backed thread files are restored when a new toolbox sandbox is created.
