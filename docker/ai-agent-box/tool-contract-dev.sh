#!/usr/bin/env bash
set -euo pipefail

/usr/local/libexec/runtime-tool-contract.sh

required_commands=(dig gcc g++ make gpg)
missing=()
for command_name in "${required_commands[@]}"; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    missing+=("${command_name}")
  fi
done

if ((${#missing[@]} > 0)); then
  printf 'Missing required development commands: %s\n' "${missing[*]}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

printf 'int main(void) { return 0; }\n' > "${tmp_dir}/contract.c"
gcc "${tmp_dir}/contract.c" -o "${tmp_dir}/contract-c"
"${tmp_dir}/contract-c"

printf 'int main() { return 0; }\n' > "${tmp_dir}/contract.cpp"
g++ "${tmp_dir}/contract.cpp" -o "${tmp_dir}/contract-cpp"
"${tmp_dir}/contract-cpp"

printf 'ai-agent-box development contract passed\n'
