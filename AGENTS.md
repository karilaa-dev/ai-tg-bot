# Repository instructions

## Application version

- Bump `package.json` only when preparing a new application release. Compare it with the latest published release and bump it if the version has not already been updated for the upcoming release. Use a patch bump unless the changes require a minor or major release.
- After changing the version, run `bun install` to keep `bun.lock` in sync. Bun's lockfile does not store the application version. Keep version examples in documentation and version assertions in tests in sync.

## E2B sandbox image

- Changes to `e2b-template/`, its installed tools, or its copied assets require a new E2B sandbox image for the application release that includes them.
- During release preparation, run `bun run e2b:release` after the local typecheck, tests, and build pass. The command builds or reuses the image for the app version, validates it, and runs the live E2B smoke test.
- E2B version tags are immutable. If `ai-tg-bot-tools:v<version>` already exists and the image contents changed, choose a new app version during release preparation before running the release command.
