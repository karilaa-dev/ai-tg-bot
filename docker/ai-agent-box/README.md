# AI agent box image

`ghcr.io/karilaa-dev/ai-agent-box` provides lightweight Alpine 3.22 environments for isolated AI agent workloads. The images contain tools only; they do not contain the Telegram bot application, repository source, or credentials.

## Image variants

### Runtime image (default)

The `latest`, `runtime`, `sha-<commit>`, and `runtime-sha-<commit>` tags contain the default low-latency environment:

- Bash and GNU core/search/text utilities
- Python 3.12 with pip, venv, and a `python` compatibility alias for `python3`
- Node.js 22 with npm
- tar, gzip, bzip2, xz, zstd, ZIP, and unzip
- curl, wget, CA certificates, Git, and the OpenSSH client
- jq, ripgrep (`rg`), fd, file, tree, less, and `patch`
- SQLite and basic process/network commands
- `gcompat` for limited compatibility with some glibc-targeted software

The runtime image intentionally omits compilers and the larger diagnostic suites. Native Python or npm dependencies work when they publish compatible musllinux packages; packages that require local compilation need the development image.

### Development image

The `dev` and `dev-sha-<commit>` tags extend the runtime image with:

- GCC, G++, make, musl development headers, and common build tools
- `dig`, full iproute2/procps utilities, and GnuPG

Use this variant for source builds or when the full historical toolbox contract is required:

```dotenv
OPEN_SANDBOX_IMAGE=ghcr.io/karilaa-dev/ai-agent-box:dev-sha-<commit>
```

Alpine uses musl rather than glibc. This materially reduces image transfer and extraction work, but arbitrary precompiled Linux binaries and packages without musllinux support may not run. For example, the benchmark found that NumPy and `better-sqlite3` installed successfully while the PyPI `onnxruntime` package had no compatible Alpine distribution. Choose the development image when a compatible source distribution is available and can be compiled; choose a glibc-based custom image for workloads that require glibc-only binaries or publish no musl source package.

When migrating from the former Ubuntu image, recreate persisted Python virtual environments, native npm dependencies, and compiled binaries inside the mounted current workspace or `/data/shared`; glibc-built artifacts are not expected to work on musl. Ordinary source files and other platform-independent data remain compatible.

## Runtime contract

Both variants define `agent` with UID/GID `1000:1000`, home directory `/home/agent`, and working directory `/workspace`. The container defaults to root because OpenSandbox's injected `execd` process needs to switch command identities; the bot runs every agent command as `OPEN_SANDBOX_UID=1000` and `OPEN_SANDBOX_GID=1000`, and owns private command-input files with `OPEN_SANDBOX_USER=agent` and `OPEN_SANDBOX_GROUP=agent`.

Custom names must exist in the image and resolve to the configured numeric identity. UID and GID must be nonzero, and the runner UID should stay aligned with the bot's `APP_UID` so bind-mounted files remain readable for export. The current workspace, attachment-staging directory, and user-shared host directory mounted by OpenSandbox must be writable by the configured identity; attachment staging is read-only from inside the runner.

The images intentionally do not include credentials, a Docker client or socket, an SSH server, or bot application files. Supply only user-scoped data through appropriately scoped mounts. User-level Python and npm installs persist reliably only when their target is inside the mounted current workspace or `/data/shared`; other writable layers depend on OpenSandbox retaining the same sandbox.

Run a contract check with:

```sh
docker run --rm --user 1000:1000 \
  ghcr.io/karilaa-dev/ai-agent-box:latest \
  /usr/local/bin/tool-contract.sh
```

## Size and startup findings

Local amd64 benchmarks compared equivalent candidates on an 8-core Docker host. Sizes below are Docker's unpacked image size; cached startup measured `docker run` through the first successful non-root command. OpenSandbox measured sandbox creation through the first successful command.

| Candidate | Size | Cached Docker median | Cached OpenSandbox median |
|---|---:|---:|---:|
| Ubuntu 24.04 full baseline | 255.7 MB | 670 ms | 5.17 s |
| Debian Bookworm full | 249.1 MB | 661 ms | 4.92 s |
| Alpine 3.22 full/dev | 161.3 MB | approximately 650 ms | 4.93 s |
| Alpine 3.22 runtime | 66.9 MB | no material change | no material change |

A separate three-run cold load-and-first-command benchmark measured medians of 7.90 seconds for Ubuntu, 6.74 seconds for Debian full, and 4.33 seconds for Alpine full. Cached container creation and OpenSandbox provisioning were effectively independent of image size: OpenSandbox's runtime injection and egress setup dominated the roughly five-second cached path. The runtime image therefore primarily improves first pull/unpack on a new or pruned host; normal pause/resume is not expected to improve.

The publish workflow enforces unpacked budgets of 100 MiB for runtime and 220 MiB for dev on both amd64 and arm64.

## Use

Pull and open an interactive runtime shell with the current directory mounted as the workspace:

```sh
docker pull ghcr.io/karilaa-dev/ai-agent-box:latest
docker run --rm -it \
  --user 1000:1000 \
  -v "$PWD:/workspace" \
  ghcr.io/karilaa-dev/ai-agent-box:latest bash
```

Published images support `linux/amd64` and `linux/arm64`. Pin an immutable `sha-*`, `runtime-sha-*`, or `dev-sha-*` tag in production rather than relying on a mutable tag.

## Package visibility and authentication

A newly created GHCR package may require authentication until its visibility is changed to public. For an authenticated pull, use a GitHub personal access token with `read:packages`:

```sh
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io \
  --username YOUR_GITHUB_USERNAME \
  --password-stdin
docker pull ghcr.io/karilaa-dev/ai-agent-box:latest
```

After the first successful push, an organization owner should open the [package settings](https://github.com/orgs/karilaa-dev/packages/container/ai-agent-box/settings), choose **Change visibility**, and set the package to **Public**.

## Build locally

From the repository root:

```sh
docker build --target runtime -t ai-agent-box:runtime docker/ai-agent-box
docker build --target dev -t ai-agent-box:dev docker/ai-agent-box

docker run --rm --user 1000:1000 \
  ai-agent-box:runtime /usr/local/bin/tool-contract.sh
docker run --rm --user 1000:1000 \
  ai-agent-box:dev /usr/local/bin/tool-contract.sh

docker image inspect --format '{{.Size}}' ai-agent-box:runtime
docker image inspect --format '{{.Size}}' ai-agent-box:dev
```

The directory-local `.dockerignore` limits the build context to the Dockerfile and contract scripts.
