#!/usr/bin/env bash
set -euo pipefail

required_commands=(
  bash sh tail ls cp mv rm mkdir find grep sed awk cat cmp cut id mktemp
  tar gzip bzip2 xz zip unzip zstd curl wget git ssh jq rg fd file tree less
  sqlite3 ps ip patch dig gcc g++ make gpg magick python python3 pip3 node npm
  officecli
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

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

python3 -m venv "${tmp_dir}/venv"
"${tmp_dir}/venv/bin/python" -c 'import json, pathlib, sqlite3, tarfile, zipfile'
"${tmp_dir}/venv/bin/python" -m pip --version >/dev/null
[[ "$(python -c 'import sys; print(sys.version_info[:2])')" == "$(python3 -c 'import sys; print(sys.version_info[:2])')" ]]

node --version >/dev/null
npm --version >/dev/null
officecli --version
officecli help pptx >/dev/null

pptx_skill=/usr/local/share/officecli/skills/officecli-pptx/SKILL.md
docx_skill=/usr/local/share/officecli/skills/officecli-docx/SKILL.md
[[ -r "${pptx_skill}" ]]
[[ -r "${docx_skill}" ]]
grep -Fq 'name: officecli-pptx' "${pptx_skill}"
grep -Fq '## QA (Required)' "${pptx_skill}"
grep -Fq 'Gate 3 — Visual audit (MANDATORY)' "${pptx_skill}"
grep -Fq 'name: officecli-docx' "${docx_skill}"
grep -Fq '## QA (Required)' "${docx_skill}"

magick -size 2x2 xc:red "${tmp_dir}/image.png"
[[ "$(magick identify -format '%wx%h' "${tmp_dir}/image.png")" == "2x2" ]]
magick "${tmp_dir}/image.png" -resize 1x1 -strip "${tmp_dir}/image.jpg"
[[ "$(magick identify -format '%wx%h' "${tmp_dir}/image.jpg")" == "1x1" ]]

(
  cd "${tmp_dir}"
  officecli create contract.pptx
  officecli add contract.pptx / --type slide --prop layout=blank --prop background=FFFFFF
  officecli add contract.pptx "/slide[1]" --type shape \
    --prop text="OfficeCLI contract" \
    --prop x=2cm --prop y=2cm --prop width=20cm --prop height=2cm \
    --prop size=36 --prop color=111111
  officecli save contract.pptx
  officecli validate contract.pptx
  officecli view contract.pptx html --page 1 --out contract-slide.html
  grep -qi '<html' contract-slide.html

  officecli create contract.docx
  officecli add contract.docx /body --type paragraph \
    --prop text="OfficeCLI contract" --prop style=Heading1
  officecli save contract.docx
  officecli validate contract.docx
)

printf 'archive-ok' > "${tmp_dir}/archive-input"
(
  cd "${tmp_dir}"
  zip -q archive.zip archive-input
  unzip -tq archive.zip >/dev/null
)

printf 'zstd-round-trip' > "${tmp_dir}/zstd-input"
zstd -q "${tmp_dir}/zstd-input" -o "${tmp_dir}/zstd-input.zst"
zstd -q -d "${tmp_dir}/zstd-input.zst" -o "${tmp_dir}/zstd-output"
cmp "${tmp_dir}/zstd-input" "${tmp_dir}/zstd-output"

sqlite3 "${tmp_dir}/contract.db" 'create table checks(value); insert into checks values(1);'
[[ "$(sqlite3 "${tmp_dir}/contract.db" 'select value from checks;')" == 1 ]]

printf 'before\n' > "${tmp_dir}/patched.txt"
printf '%s\n' '--- patched.txt' '+++ patched.txt' '@@ -1 +1 @@' '-before' '+after' > "${tmp_dir}/change.patch"
(
  cd "${tmp_dir}"
  patch -s < change.patch
)
[[ "$(cat "${tmp_dir}/patched.txt")" == after ]]

printf 'int main(void) { return 0; }\n' > "${tmp_dir}/contract.c"
gcc "${tmp_dir}/contract.c" -o "${tmp_dir}/contract-c"
"${tmp_dir}/contract-c"

printf 'int main() { return 0; }\n' > "${tmp_dir}/contract.cpp"
g++ "${tmp_dir}/contract.cpp" -o "${tmp_dir}/contract-cpp"
"${tmp_dir}/contract-cpp"

source /etc/os-release
[[ "${ID}" == debian ]]
[[ "$(id -u)" == 1000 ]]
[[ "$(id -g)" == 1000 ]]
[[ "$(id -un)" == user ]]
[[ "${HOME}" == /home/user ]]
[[ -w /home/user/workspace ]]

for forbidden_command in docker dockerd sshd chromium chromium-browser google-chrome playwright; do
  if command -v "${forbidden_command}" >/dev/null 2>&1; then
    printf 'Forbidden command is installed: %s\n' "${forbidden_command}" >&2
    exit 1
  fi
done

printf 'ai-tg-bot E2B toolbox contract passed (Node.js %s, Python %s, uid=%s, gid=%s)\n' \
  "$(node --version)" \
  "$(python3 --version | cut -d' ' -f2)" \
  "$(id -u)" \
  "$(id -g)"
