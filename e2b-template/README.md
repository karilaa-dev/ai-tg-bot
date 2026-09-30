# E2B toolbox template

This directory defines the private `ai-tg-bot-tools` template used by thread sandboxes. It starts from E2B Base with 2 vCPU and 2 GiB RAM.

The image contains the shell tools listed in `template.ts`, ImageMagick, docx-cli `0.26.0`, PptxGenJS `4.0.1`, python-pptx `1.0.2`, openpyxl `3.1.5`, headless LibreOffice Writer/Impress/Calc and compatible fonts, the pinned OpenSCAD `2026.09.29` Node/WebAssembly engine, POV-Ray `3.7.0.10`, `openscad-build`, PDF Inspector `1.25.2`, and Poppler PDF rendering tools. The OpenSCAD pipeline exports binary STL and exact rendered PNG files without Xvfb, an X server, or OpenGL. Python, Node.js, and npm come from E2B Base and are checked by the contract. Chromium and browser automation packages are absent because Browser Use Cloud handles browser work.

## Versioned release

The default tag comes from the application version in `package.json`. Version `3.0.0` uses `ai-tg-bot-tools:v3.0.0`. Put the normal application secrets, including `E2B_API_KEY`, in the ignored root `.env`.

Build the versioned image and run the full live runtime smoke before deployment:

```sh
bun run e2b:release
```

If the version tag already exists, the command reuses and validates it instead of rebuilding it. The command prints the exact `E2B_TEMPLATE` reference after the smoke passes. A bot process never builds a missing image during sandbox creation. It fails with the missing reference and this command instead.

Low-level commands remain available for diagnostics and manual recovery:

```sh
bun run e2b:template:build
E2B_TEMPLATE=ai-tg-bot-tools:<tag> bun run live:e2b-check
E2B_TEMPLATE=ai-tg-bot-tools:<tag> bun run e2b:template:check
```

The legacy mutable production alias can still be assigned explicitly:

```sh
E2B_PROMOTE_TAG=<tag> bun run e2b:template:promote
```

The full live smoke checks the toolbox contract, outbound internet, allocated CPU and memory, and pause/resume persistence. An explicit `E2B_TEMPLATE` override can select an earlier tag for newly created sandboxes.

Keep `E2B_DEPLOYMENT_ID` and all `thread_sandboxes` mappings during a bot upgrade. A mapped thread reconnects its original sandbox, so old workspaces and image versions remain intact. Deleting a mapping while changing `E2B_TEMPLATE` can make the old sandbox undiscoverable and cause the bot to create a replacement.

Pinned tool versions may trail upstream. Upgrade a pin only after updating its revision and checksums and passing the full template contract.

The Office bundle in `assets/office` contains the shared installer, locked Node and Python dependencies, runtime wrappers, tested deck examples, licenses, and the actual-file checker. New images and existing sandbox upgrades use this same bundle. The installer runs `office-contract` before recording its content revision or removing old tools. Existing sandboxes retain their mappings, workspaces, and immutable file sources.

`office-contract` tests Word creation, targeted replacements, tracked changes and comments, new decks with artwork/tables/charts, preservation during existing-deck edits, Excel formula recalculation, and actual-file page rendering. It prints conversion time and peak child-process RSS. The image remains 2 vCPU / 2048 MiB; full contracts run inside that allocation. LibreOffice package versions come from the base distribution and are recorded in every rendering report.

After releasing the image, run `bun run live:codex-executor-check` to verify native shell, patching, image viewing, automatic attachment restoration, pause/resume, and recreation after deletion. This check uses a controlled Responses provider, so it makes no paid model calls and sends no Telegram messages. E2B sandbox execution and the existing attachment restoration pipeline are real; the Telegram download source is a deterministic fixture. It removes its disposable sandboxes and temporary Codex home.

To verify an in-place upgrade, run `E2B_UPGRADE_FROM=ai-tg-bot-tools:v2.0.6 bun run live:e2b-check`. It creates a disposable sandbox from that earlier image and checks that upgrading preserves its identity, workspace, and saved sources, removes obsolete bundle files, and serializes concurrent installers. See [the 2.0.7 review fixes](../docs/office-review-2.0.7.md) and [the original resource measurements](../docs/office-tools-2.0.6.md).

## Native Codex executor

The v3 image includes Codex `0.159.2` and the `ai-tg-codex-executor` wrapper. The bot runs the persistent Codex app-server locally. Each conversation uses an authenticated local lazy adapter that starts or resumes E2B only when a native execution or filesystem operation needs it. Ordinary executor traffic uses one persistent secure WebSocket to the E2B port endpoint. The executor listens on port `8765` with capability-token authentication; it does not use stdin/stdout transport.

The token is unique to the conversation sandbox and stored in a private directory with a mode `0600` token file. E2B receives no bot token, Codex subscription credentials, OpenRouter key, or other host credentials. Executor initialization overlaps automatic attachment restoration, and the first operation waits for both to finish. Telegram files keep their stable `/home/user/telegram-files` paths. Transfers use the current bounded materializer without a host attachment byte cache.

Pause/resume preserves the executor process and workspace. If a sandbox has been deleted, its replacement restores every recoverable attachment visible to that conversation before execution. Existing v2 sandboxes are upgraded in place on their first native operation, installing the pinned executor once while preserving mappings, workspaces, and file sources. Native image outputs stay on the bot host for Telegram delivery; when a later sandbox tool needs them, their known generated paths are staged into E2B automatically.
