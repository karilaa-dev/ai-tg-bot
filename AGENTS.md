# Repository instructions

## Application version

- Start every pull request by checking the application version against the target branch.
- If the pull request has not changed the version yet, bump `package.json` and `package-lock.json` before making other changes. Use a patch bump unless the work requires a minor or major release.
- Bump the version only once per pull request. Keep version examples in documentation and version assertions in tests in sync.

## E2B sandbox image

- Changes to `e2b-template/`, its installed tools, or its copied assets require a new E2B sandbox image.
- Run `npm run e2b:release` after the local typecheck, tests, and build pass. This command builds the image for the app version, validates it, and runs the live E2B smoke test.
- E2B version tags are immutable. Because every pull request starts with a new app version, sandbox changes get a new `ai-tg-bot-tools:v<version>` tag. If that tag already exists and the image contents changed, bump the app version again before running the release command.

