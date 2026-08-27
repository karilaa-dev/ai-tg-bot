# E2B toolbox template

This directory defines the private `ai-tg-bot-tools` template used by thread sandboxes. It starts from E2B Base with 2 vCPU and 2 GiB RAM.

The image contains the shell tools listed in `template.ts`, ImageMagick, OfficeCLI `1.0.145`, the pinned OpenSCAD `2026.08.27` Node/WebAssembly engine, POV-Ray `3.7.0.10`, `openscad-build`, PDF Inspector `1.17.0`, and Poppler PDF rendering tools. The OpenSCAD pipeline exports binary STL and exact rendered PNG files without Xvfb, an X server, or OpenGL. Python, Node.js, and npm come from E2B Base and are checked by the contract. Chromium and browser automation packages are absent because Browser Use Cloud handles browser work.

## Versioned release

The default tag comes from the application version in `package.json`. Version `2.0.3` uses `ai-tg-bot-tools:v2.0.3`. Put the normal application secrets, including `E2B_API_KEY`, in the ignored root `.env`.

Build the versioned image and run the full live runtime smoke before deployment:

```sh
npm run e2b:release
```

If the version tag already exists, the command reuses and validates it instead of rebuilding it. The command prints the exact `E2B_TEMPLATE` reference after the smoke passes. A bot process never builds a missing image during sandbox creation. It fails with the missing reference and this command instead.

Low-level commands remain available for diagnostics and manual recovery:

```sh
npm run e2b:template:build
E2B_TEMPLATE=ai-tg-bot-tools:<tag> npm run live:e2b-check
E2B_TEMPLATE=ai-tg-bot-tools:<tag> npm run e2b:template:check
```

The legacy mutable production alias can still be assigned explicitly:

```sh
E2B_PROMOTE_TAG=<tag> npm run e2b:template:promote
```

The full live smoke checks the toolbox contract, outbound internet, allocated CPU and memory, and pause/resume persistence. An explicit `E2B_TEMPLATE` override can select an earlier tag for newly created sandboxes.

Keep `E2B_DEPLOYMENT_ID` and all `thread_sandboxes` mappings during a bot upgrade. A mapped thread reconnects its original sandbox, so old workspaces and image versions remain intact. Deleting a mapping while changing `E2B_TEMPLATE` can make the old sandbox undiscoverable and cause the bot to create a replacement.

Pinned tool versions may trail upstream. Upgrade a pin only after updating its revision and checksums and passing the full template contract.
