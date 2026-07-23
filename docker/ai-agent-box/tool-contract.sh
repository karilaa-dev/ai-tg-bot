#!/usr/bin/env bash
set -euo pipefail

required_commands=(
  bash sh ls cp mv rm mkdir find grep sed awk tar gzip bzip2 xz
  zip unzip curl wget git ssh jq rg fd file tree less sqlite3
  ps ip dig gcc g++ make python3 pip3 node npm
)

missing=()
for command_name in "${required_commands[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    missing+=("${command_name}")
  fi
done

if ((${#missing[@]} > 0)); then
  printf 'Missing required commands: %s\n' "${missing[*]}" >&2
  exit 1
fi

# Validate capabilities that command discovery alone does not cover.
python3 -m venv --help >/dev/null
[[ "$(node --version)" == v22.* ]]

source /etc/os-release
[[ "${ID}" == ubuntu ]]
[[ "${VERSION_ID}" == 24.04 ]]

[[ "$(id -u)" == 1000 ]]
[[ "$(id -g)" == 1000 ]]
[[ "$(id -un)" == agent ]]
[[ "$(npm config get prefix)" == /home/agent/.local ]]
[[ -w /home/agent/.local ]]
[[ -w /home/agent/.cache/pip ]]

for forbidden_command in docker dockerd sshd; do
  if command -v "${forbidden_command}" >/dev/null 2>&1; then
    printf 'Forbidden command is installed: %s\n' "${forbidden_command}" >&2
    exit 1
  fi
done

printf 'ai-agent-box tool contract passed (Ubuntu %s, Node.js %s, Python %s, uid=%s, gid=%s)\n' \
  "${VERSION_ID}" \
  "$(node --version)" \
  "$(python3 --version | cut -d' ' -f2)" \
  "$(id -u)" \
  "$(id -g)"
