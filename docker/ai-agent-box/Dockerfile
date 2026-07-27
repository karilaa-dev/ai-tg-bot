FROM alpine:3.24.1@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b AS base

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

RUN ln -s /usr/bin/python3 /usr/local/bin/python \
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
