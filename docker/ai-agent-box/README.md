# AI agent box image

`ghcr.io/karilaa-dev/ai-agent-box` is a general-purpose Ubuntu 24.04 LTS environment for running isolated AI agent workloads. It contains tools only; it does not contain the Telegram bot application or repository source.

## Runtime contract

The image defines `agent` with UID/GID `1000:1000`, home directory `/home/agent`, and working directory `/workspace`. The container defaults to root because OpenSandbox's injected `execd` process needs to switch command identities; the bot runs every agent command as `OPEN_SANDBOX_UID=1000` and `OPEN_SANDBOX_GID=1000`, and owns private command-input files with `OPEN_SANDBOX_USER=agent` and `OPEN_SANDBOX_GROUP=agent`. Custom names must exist in the image and resolve to the configured numeric identity, and `OPEN_SANDBOX_GID` must be nonzero. A different numeric identity still needs suitable home/tool directories and filesystem permissions. The per-user host directory mounted by OpenSandbox at `/data` must be writable by the configured identity. The image includes:

- Python 3 with pip and venv
- Node.js 22 with npm
- Bash, core utilities, archive tools, and build tooling
- curl, wget, Git, and the OpenSSH client
- jq, ripgrep (`rg`), fd, file, tree, and less
- SQLite, procps, iproute2, and DNS utilities

The image intentionally does not include credentials, a Docker client or socket, an SSH server, or bot application files. Supply required data and credentials at runtime using appropriately scoped mounts or environment injection. The bot mounts only one user's host subtree at `/data`. User-level Python and npm installs persist only if their target is under that mounted tree; the container's other writable layers depend on OpenSandbox lifecycle retention and should not be treated as durable backup storage.

Run the installed contract check with:

```sh
docker run --rm --user 1000:1000 ghcr.io/karilaa-dev/ai-agent-box:latest \
  /usr/local/bin/tool-contract.sh
```

## Use

Pull and open an interactive shell with the current directory mounted as the workspace:

```sh
docker pull ghcr.io/karilaa-dev/ai-agent-box:latest
docker run --rm -it \
  --user 1000:1000 \
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
docker run --rm --user 1000:1000 ai-agent-box:local /usr/local/bin/tool-contract.sh
```

The directory-local `.dockerignore` limits the build context to the Dockerfile and tool contract script.
