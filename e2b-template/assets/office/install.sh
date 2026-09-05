#!/usr/bin/env bash
set -euo pipefail
bundle=$(cd -- "$(dirname -- "$0")" && pwd)
exec 9>/var/lock/ai-tg-bot-office-install.lock
flock -x 9
revision=$(find "$bundle" -type f ! -path '*/node_modules/*' ! -path '*/python/*' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
if [[ -f /opt/office/installed-revision ]] && [[ $(cat /opt/office/installed-revision) == "$revision" ]]; then
  /usr/local/bin/docx --version >/dev/null
  /opt/office/python/bin/python -c 'import pptx, openpyxl, lxml'
  libreoffice --version >/dev/null
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation poppler-utils python3-venv
mkdir -p /opt/office/node /opt/office/licenses
cp "$bundle/package.json" "$bundle/package-lock.json" /opt/office/node/
npm ci --prefix /opt/office/node --omit=dev --ignore-scripts --no-audit --no-fund
python3 -m venv /opt/office/python
/opt/office/python/bin/pip install --require-hashes -r "$bundle/requirements.txt"
case $(uname -m) in
 x86_64) platform=x64; digest=e59d32f2a1ffd696bbb816015bea1f437cba4f3864e0e62f6b83df9acc55bfe6 ;;
 aarch64|arm64) platform=arm64; digest=d6581b9642081a6fa8b7c2c6ae512ee35b8a12ff77b224777a40989d6440f38d ;;
 *) printf 'Unsupported Office architecture\n' >&2; exit 1 ;;
esac
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
curl -fsSL "https://github.com/kklimuk/docx-cli/releases/download/v0.25.0/docx-linux-$platform" -o "$staging/docx"
printf '%s  %s\n' "$digest" "$staging/docx" | sha256sum -c -
install -m0755 "$staging/docx" /usr/local/bin/docx
cp -R "$bundle/licenses/." /opt/office/licenses/
install -m0755 "$bundle/office-files.py" /usr/local/bin/office-files
install -m0755 "$bundle/office-python" /usr/local/bin/office-python
install -m0755 "$bundle/pptxgenjs-run" /usr/local/bin/pptxgenjs-run
install -m0644 "$bundle/pptx-helpers.cjs" /opt/office/node/pptx-helpers.cjs
install -m0644 "$bundle/example-deck.cjs" /opt/office/node/example-deck.cjs
install -m0755 "$bundle/contract.sh" /usr/local/bin/office-contract
fc-cache -f
/usr/local/bin/office-contract
rm -f /usr/local/bin/officecli /usr/local/libexec/officecli-bin
rm -rf /usr/local/share/officecli
printf '%s' "$revision" > /opt/office/installed-revision
printf 'Office installed size (KiB): '
du -sk /opt/office /usr/lib/libreoffice /usr/share/libreoffice 2>/dev/null || true
