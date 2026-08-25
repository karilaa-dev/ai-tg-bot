# E2B toolbox template

This directory defines the private `ai-tg-bot-tools` template used by thread sandboxes. It starts from E2B Base with 2 vCPU and 2 GiB RAM.

The image contains the shell tools listed in `template.ts`, ImageMagick, OfficeCLI `1.0.144`, PDF Inspector `1.17.0`, and Poppler PDF rendering tools. Python, Node.js, and npm come from E2B Base and are checked by the contract. Chromium and browser automation packages are deliberately absent because Browser Use Cloud handles browser work.

## Build and promote

Put `E2B_API_KEY` in the ignored root `.env`. Publish and validate the sandbox-first document build under its immutable rollout tag first:

```sh
npm run e2b:template:build:sandbox-files-v2
```

The build validates `ai-tg-bot-tools:sandbox-files-v2` without changing the production tag. Run the full live runtime smoke against that immutable tag:

```sh
npm run live:e2b-sandbox-files-v2
```

Promote only after the live smoke passes:

```sh
npm run e2b:template:promote:sandbox-files-v2
```

For later upgrades, use a fresh explicit tag or run the timestamped builder:

```sh
npm run e2b:template:build
```

The build command creates an immutable tag and starts a temporary validation sandbox. The live smoke separately checks the toolbox contract, outbound internet, allocated CPU and memory, and pause/resume persistence. The promotion command revalidates the immutable tag immediately before moving `ai-tg-bot-tools:production`. Bot startup never builds or promotes the template.

Check the current production tag without rebuilding:

```sh
npm run e2b:template:check
```

To roll back, point the `production` tag at an earlier validated build through E2B's tag API. Existing thread sandboxes keep their current build and filesystem. The new tag applies only to newly created sandboxes.

Keep `thread_sandboxes` mappings during a tag change. Metadata recovery includes `template_ref`, so deleting a mapping while also changing `E2B_TEMPLATE` can make an older sandbox undiscoverable and cause the bot to create a replacement.

Pinned tool versions may trail upstream. Upgrade a pin only after updating its revision and checksums and passing the full template contract.
