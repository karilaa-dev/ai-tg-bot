FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS base

ARG OFFICECLI_VERSION=1.0.142
ARG OFFICECLI_SOURCE_REV=e56ee7f3595cb81ff2c87cf83a32a44bd71ed07d
ARG OFFICECLI_ALPINE_AMD64_SHA256=e0f9aa822c79ca49ce14724adb20e6a3483f263db6fbb69a6a303e4f59a84346
ARG OFFICECLI_ALPINE_ARM64_SHA256=4c47ae4ce1047baa81e586d99149428874cb4eecc110928ff4684c885d029ba3
ARG OFFICECLI_DOCX_SKILL_SHA256=1da56ed53a308222ab2516a2974ae98c6703b7d504fa5158348c39a18e85a4f1
ARG OFFICECLI_PPTX_SKILL_SHA256=0d53192751d5770984f16f3c34f9923377651555c667150d7f96e16e8c9757b3
ARG TARGETARCH

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-tg-bot" \
      org.opencontainers.image.description="Lightweight Alpine tool box for isolated AI agent workloads"

RUN apk add --no-cache \
        bash \
        bzip2 \
        ca-certificates \
        coreutils \
        curl \
        fd \
        file \
        findutils \
        gawk \
        gcompat \
        git \
        grep \
        gzip \
        jq \
        less \
        libgcc \
        libstdc++ \
        nodejs \
        npm \
        openssh-client-default \
        patch \
        py3-pip \
        python3 \
        ripgrep \
        sed \
        sqlite \
        tar \
        tree \
        unzip \
        wget \
        xz \
        zip \
        zstd

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV OFFICECLI_SKIP_UPDATE=1

RUN case "${TARGETARCH}" in \
      amd64) officecli_asset="officecli-linux-alpine-x64"; officecli_sha="${OFFICECLI_ALPINE_AMD64_SHA256}" ;; \
      arm64) officecli_asset="officecli-linux-alpine-arm64"; officecli_sha="${OFFICECLI_ALPINE_ARM64_SHA256}" ;; \
      *) printf 'Unsupported OfficeCLI architecture: %s\n' "${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && officecli_tmp="$(mktemp -d)" \
    && trap 'rm -rf "${officecli_tmp}"' EXIT \
    && curl -fsSL \
      "https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/${officecli_asset}" \
      -o "${officecli_tmp}/officecli" \
    && printf '%s  %s\n' "${officecli_sha}" "${officecli_tmp}/officecli" | sha256sum -c - \
    && install -Dm0755 "${officecli_tmp}/officecli" /usr/local/bin/officecli \
    && for skill in docx pptx; do \
      curl -fsSL \
        "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/${OFFICECLI_SOURCE_REV}/skills/officecli-${skill}/SKILL.md" \
        -o "${officecli_tmp}/officecli-${skill}.md"; \
    done \
    && printf '%s  %s\n' "${OFFICECLI_DOCX_SKILL_SHA256}" "${officecli_tmp}/officecli-docx.md" | sha256sum -c - \
    && printf '%s  %s\n' "${OFFICECLI_PPTX_SKILL_SHA256}" "${officecli_tmp}/officecli-pptx.md" | sha256sum -c - \
    && install -Dm0644 "${officecli_tmp}/officecli-docx.md" \
      /usr/local/share/officecli/skills/officecli-docx/SKILL.md \
    && install -Dm0644 "${officecli_tmp}/officecli-pptx.md" \
      /usr/local/share/officecli/skills/officecli-pptx/SKILL.md \
    && for legal_file in LICENSE NOTICE; do \
      curl -fsSL \
        "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/${OFFICECLI_SOURCE_REV}/${legal_file}" \
        -o "${officecli_tmp}/${legal_file}"; \
      install -Dm0644 "${officecli_tmp}/${legal_file}" \
        "/usr/local/share/licenses/officecli/${legal_file}"; \
    done \
    && officecli --version \
    && ln -s /usr/bin/python3 /usr/local/bin/python \
    && addgroup -g 1000 agent \
    && adduser -D -u 1000 -G agent -h /home/agent -s /bin/bash agent \
    && install -d -o agent -g agent \
        /workspace \
        /data \
        /home/agent/.local \
        /home/agent/.local/bin \
        /home/agent/.cache \
        /home/agent/.cache/pip \
        /home/agent/.npm

COPY --chmod=0755 tool-contract.sh /usr/local/libexec/runtime-tool-contract.sh

WORKDIR /workspace

ENV HOME=/home/agent \
    NPM_CONFIG_PREFIX=/home/agent/.local \
    PYTHONUSERBASE=/home/agent/.local \
    PIP_CACHE_DIR=/home/agent/.cache/pip \
    PATH=/home/agent/.local/bin:$PATH

CMD ["/bin/sleep", "infinity"]

FROM base AS dev

RUN apk add --no-cache \
        bind-tools \
        build-base \
        gnupg \
        iproute2 \
        procps-ng

COPY --chmod=0755 tool-contract-dev.sh /usr/local/bin/tool-contract.sh

FROM base AS runtime

RUN ln -s /usr/local/libexec/runtime-tool-contract.sh /usr/local/bin/tool-contract.sh
