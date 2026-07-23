# AI agent box image

`ghcr.io/karilaa-dev/ai-agent-box` is a general-purpose Ubuntu 24.04 LTS environment for running isolated AI agent workloads. It contains tools only; it does not contain the Telegram bot application or repository source.

## Runtime contract

The image defines `agent` with UID/GID `1000:1000`, home directory `/home/agent`, and working directory `/workspace`. This matches the bot's default `BOXLITE_GUEST_USER=agent`. A different username must exist in the selected image; numeric UID or `UID:GID` values are passed directly but still need suitable home/tool directories and filesystem permissions. The shared BoxLite volume must be writable by the configured guest identity. The image includes:

- Python 3 with pip and venv
- Node.js 22 with npm
- Bash, core utilities, archive tools, and build tooling
- curl, wget, Git, and the OpenSSH client
- jq, ripgrep (`rg`), fd, file, tree, and less
- SQLite, procps, iproute2, and DNS utilities

The image intentionally does not include credentials, a Docker client or socket, an SSH server, or bot application files. Supply required data and credentials at runtime using appropriately scoped mounts or environment injection. User-level Python installs (`pip install --user`) and npm global installs use writable paths under `/home/agent/.local`, which persist on the BoxLite disk.

Run the installed contract check with:

```sh
docker run --rm ghcr.io/karilaa-dev/ai-agent-box:latest \
  /usr/local/bin/tool-contract.sh
```

## Use

Pull and open an interactive shell with the current directory mounted as the workspace:

```sh
docker pull ghcr.io/karilaa-dev/ai-agent-box:latest
docker run --rm -it \
  -v "$PWD:/workspace" \
  ghcr.io/karilaa-dev/ai-agent-box:latest bash
```

Published tags are `latest` and `sha-<full-commit-sha>` for each successful build from `main`. Images are published for `linux/amd64` and `linux/arm64`. A manual workflow run from another branch builds and smoke-tests the image but does not publish it.

## Package visibility and authentication

A newly created GHCR package may require authentication until its visibility is changed to public. For an authenticated pull, use a GitHub personal access token with `read:packages`:

```sh
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io \
  --username YOUR_GITHUB_USERNAME \
  --password-stdin
docker pull ghcr.io/karilaa-dev/ai-agent-box:latest
```

After the first successful push, an organization owner should open the [package settings](https://github.com/orgs/karilaa-dev/packages/container/ai-agent-box/settings), choose **Change visibility**, and set the package to **Public**. Once public, pulling the image does not require GHCR authentication.

## Build locally

From the repository root:

```sh
docker build -t ai-agent-box:local docker/ai-agent-box
docker run --rm ai-agent-box:local /usr/local/bin/tool-contract.sh
```

The directory-local `.dockerignore` limits the build context to the Dockerfile and tool contract script.
