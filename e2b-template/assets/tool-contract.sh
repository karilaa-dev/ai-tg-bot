#!/usr/bin/env bash
set -euo pipefail

required_commands=(
  bash sh tail ls cp mv rm mkdir find grep sed awk cat cmp cut id mktemp
  tar gzip bzip2 xz zip unzip zstd curl wget git ssh jq rg fd file tree less
  sqlite3 ps ip patch dig gcc g++ make gpg magick python python3 pip3 node npm
  officecli pdf-inspector pdfinfo pdftoppm openscad openscad-build xvfb-run
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
[[ "$(pdf-inspector --version)" == "1.17.0" ]]

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

mkdir "${tmp_dir}/openscad"
cat > "${tmp_dir}/openscad/test.scad" <<'SCAD'
difference() {
  cube([20, 20, 10], center = true);
  cylinder(h = 12, d = 8, center = true, $fn = 48);
}
SCAD
openscad-build preview "${tmp_dir}/openscad/test.scad"
openscad-build final "${tmp_dir}/openscad/test.scad"
[[ -s "${tmp_dir}/openscad/test.preview.png" ]]
[[ -s "${tmp_dir}/openscad/test.final.png" ]]
[[ -s "${tmp_dir}/openscad/test.stl" ]]
[[ -s "${tmp_dir}/openscad/test.3mf" ]]

python3 - "${tmp_dir}/contract.pdf" <<'PY'
import sys

target = sys.argv[1]
stream = "BT\n/F1 18 Tf\n72 720 Td\n(PDF Inspector contract) Tj\nET"
objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    f"5 0 obj\n<< /Length {len(stream.encode())} >>\nstream\n{stream}\nendstream\nendobj\n",
]
pdf = "%PDF-1.4\n"
offsets = []
for obj in objects:
    offsets.append(len(pdf.encode()))
    pdf += obj
xref = len(pdf.encode())
pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n"
pdf += "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n"
with open(target, "wb") as handle:
    handle.write(pdf.encode())
PY

pdf-inspector detect "${tmp_dir}/contract.pdf" --json | jq -e '.pdfType == "TextBased" or .pdf_type == "text_based"' >/dev/null
pdf-inspector "${tmp_dir}/contract.pdf" -o "${tmp_dir}/contract.md"
grep -Fq 'PDF Inspector contract' "${tmp_dir}/contract.md"
pdfinfo "${tmp_dir}/contract.pdf" | grep -Eq '^Pages:[[:space:]]+1$'

python3 - "${tmp_dir}/scanned.pdf" <<'PY'
import sys, zlib

target = sys.argv[1]
width = height = 64
image = zlib.compress(bytes([255, 255, 255]) * width * height)
content = b"q\n612 0 0 792 0 0 cm\n/Im0 Do\nQ\n"
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>",
    f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length {len(image)} >>\nstream\n".encode() + image + b"\nendstream",
    f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"endstream",
]
pdf = bytearray(b"%PDF-1.4\n")
offsets = []
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
xref = len(pdf)
pdf += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
for offset in offsets:
    pdf += f"{offset:010d} 00000 n \n".encode()
pdf += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
with open(target, "wb") as handle:
    handle.write(pdf)
PY

pdf-inspector detect "${tmp_dir}/scanned.pdf" --json | jq -e '.pdfType == "Scanned"' >/dev/null
pdftoppm -f 1 -l 1 -singlefile -r 72 -jpeg "${tmp_dir}/scanned.pdf" "${tmp_dir}/contract-page"
[[ -s "${tmp_dir}/contract-page.jpg" ]]
[[ "$(magick identify -format '%m' "${tmp_dir}/contract-page.jpg")" == "JPEG" ]]

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
  officecli view contract.docx outline | grep -Fq 'OfficeCLI contract'
  officecli view contract.docx text --max-lines 20 | grep -Fq 'OfficeCLI contract'
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
