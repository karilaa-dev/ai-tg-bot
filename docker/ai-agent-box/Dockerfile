FROM ubuntu:24.04

LABEL org.opencontainers.image.source="https://github.com/karilaa-dev/ai-tg-bot" \
      org.opencontainers.image.description="General-purpose Ubuntu tool box for isolated AI agent workloads"

ARG DEBIAN_FRONTEND=noninteractive

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        build-essential \
        bzip2 \
        ca-certificates \
        coreutils \
        curl \
        dnsutils \
        fd-find \
        file \
        findutils \
        gawk \
        git \
        gnupg \
        grep \
        gzip \
        iproute2 \
        jq \
        less \
        openssh-client \
        procps \
        python3 \
        python3-pip \
        python3-venv \
        ripgrep \
        sed \
        sqlite3 \
        tar \
        tree \
        unzip \
        wget \
        xz-utils \
        zip \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
    && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
        > /etc/apt/sources.list.d/nodesource.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && ln -s /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

RUN existing_user="$(getent passwd 1000 | cut -d: -f1 || true)" \
    && if [[ -n "${existing_user}" ]]; then userdel --remove "${existing_user}"; fi \
    && existing_group="$(getent group 1000 | cut -d: -f1 || true)" \
    && if [[ -n "${existing_group}" ]]; then groupdel "${existing_group}"; fi \
    && groupadd --gid 1000 agent \
    && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash agent \
    && install -d -o agent -g agent /workspace /home/agent/.local/bin /home/agent/.cache/pip /home/agent/.npm

COPY --chmod=0755 tool-contract.sh /usr/local/bin/tool-contract.sh

USER agent
WORKDIR /workspace

ENV HOME=/home/agent \
    NPM_CONFIG_PREFIX=/home/agent/.local \
    PATH=/home/agent/.local/bin:$PATH

CMD ["sleep", "infinity"]
