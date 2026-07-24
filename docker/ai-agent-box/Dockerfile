FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS base

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
        zip

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN addgroup -g 1000 agent \
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

CMD ["/usr/bin/sleep", "infinity"]

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
