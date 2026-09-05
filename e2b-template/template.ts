import { fileURLToPath } from "node:url";
import { Template, type TemplateClass } from "e2b";
import {
  E2B_TOOLBOX_PRODUCTION_REF,
  E2B_TOOLBOX_PRODUCTION_TAG,
  E2B_TOOLBOX_TEMPLATE_NAME,
} from "../src/e2b/templateIdentity.js";

export {
  E2B_TOOLBOX_PRODUCTION_REF,
  E2B_TOOLBOX_PRODUCTION_TAG,
  E2B_TOOLBOX_TEMPLATE_NAME,
};
export const E2B_TOOLBOX_CPU_COUNT = 2;
export const E2B_TOOLBOX_MEMORY_MB = 2048;

export function e2bToolboxBuildRef(tag: string): string {
  const normalized = tag.trim();
  if (!normalized || normalized.includes(":")) throw new Error("E2B toolbox build tag must be non-empty and contain no colon");
  if (normalized === E2B_TOOLBOX_PRODUCTION_TAG) {
    throw new Error("E2B toolbox build tag cannot use the reserved production tag");
  }
  return `${E2B_TOOLBOX_TEMPLATE_NAME}:${normalized}`;
}

export const PDF_INSPECTOR_VERSION = "1.17.0";

export const OPENSCAD_VERSION = "2026.08.27";
export const OPENSCAD_SOURCE_REVISION = "8020f9208e6c023086837ea07deaa9210bf50729";
export const OPENSCAD_NODE_SHA256 = "6fb5a3bfd5580b6c65d559552b79d6c4bac456d2956864e0b5432a1a28ee4508";
export const OPENSCAD_LICENSE_SHA256 = "1805a29c3bccbc0428ce0048a1dfdeb9b1867677410e99c89c3c30932ae8c7d5";
export const POVRAY_VERSION = "3.7.0.10";

const IMAGEMAGICK_VERSION = "7.1.2-30";
export const IMAGEMAGICK_COMMIT = "344e9056f43764bfdf82456faf3bc2feee98a6fe";
export const IMAGEMAGICK_SOURCE_SHA256 = "4a2329b539ae60e66e2e1f79e7f471ce5dbf35ef8261873059125248944fb1fc";

export const E2B_TOOLBOX_APT_PACKAGES = [
  "autoconf",
  "automake",
  "build-essential",
  "bzip2",
  "ca-certificates",
  "coreutils",
  "curl",
  "dnsutils",
  "fd-find",
  "file",
  "findutils",
  "gawk",
  "git",
  "gnupg",
  "gzip",
  "iproute2",
  "jq",
  "less",
  "libfontconfig1-dev",
  "libfreetype6-dev",
  "libgcc-s1",
  "libheif-dev",
  "libjpeg62-turbo-dev",
  "libpng-dev",
  "librsvg2-dev",
  "libstdc++6",
  "libtiff-dev",
  "libtool",
  "libwebp-dev",
  "libxml2-dev",
  "openssh-client",
  "patch",
  "pkg-config",
  "procps",
  "poppler-utils",
  "povray",
  "python3-pip",
  "python3-venv",
  "ripgrep",
  "sqlite3",
  "tar",
  "tree",
  "unzip",
  "wget",
  "xz-utils",
  "zip",
  "zstd",
] as const;

const contextPath = fileURLToPath(new URL(".", import.meta.url));

export function createE2BToolboxTemplate(): TemplateClass {
  return Template({
    fileContextPath: contextPath,
    fileIgnorePatterns: ["README.md", "*.ts"],
  })
    .fromBaseImage()
    .aptInstall([...E2B_TOOLBOX_APT_PACKAGES], { noInstallRecommends: true })
    .makeDir(["/usr/local/libexec", "/usr/local/libexec/openscad", "/usr/local/share/licenses/openscad"], {
      user: "root",
      mode: 0o755,
    })
    .makeDir(["/cache/fontconfig", "/home/web_user/.cache/fontconfig"], { user: "root", mode: 0o777 })
    .makeDir("/home/user/workspace", { user: "user", mode: 0o700 })
    .copyItems([
      { src: "assets/tool-contract.sh", dest: "/usr/local/bin/tool-contract.sh", user: "root", mode: 0o755 },
      { src: "assets/office", dest: "/usr/local/share/ai-tg-bot/office", user: "root" },
      { src: "assets/openscad", dest: "/usr/local/bin/openscad", user: "root", mode: 0o755 },
      { src: "assets/openscad-build", dest: "/usr/local/bin/openscad-build", user: "root", mode: 0o755 },
      { src: "assets/openscad-pov-render.mjs", dest: "/usr/local/libexec/openscad-pov-render.mjs", user: "root", mode: 0o755 },
    ])
    .makeSymlink("/usr/bin/fdfind", "/usr/local/bin/fd", { user: "root", force: true })
    .makeSymlink("/usr/local/bin/python3", "/usr/local/bin/python", { user: "root", force: true })
    .runCmd(installOpenScadCommand(), { user: "root" })
    .runCmd(installImageMagickCommand(), { user: "root" })
    .runCmd("bash /usr/local/share/ai-tg-bot/office/install.sh", { user: "root" })
    .runCmd(installPdfInspectorCommand(), { user: "root" })
    .runCmd("/usr/local/bin/tool-contract.sh", { user: "user" })
    .setWorkdir("/home/user/workspace")
    .setUser("user");
}

function installOpenScadCommand(): string {
  return `set -euo pipefail
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL "https://files.openscad.org/snapshots/OpenSCAD-${OPENSCAD_VERSION}-WebAssembly-node.zip" -o "$tmp_dir/openscad-node.zip"
printf '%s  %s\n' '${OPENSCAD_NODE_SHA256}' "$tmp_dir/openscad-node.zip" | sha256sum -c -
unzip -p "$tmp_dir/openscad-node.zip" openscad.js > "$tmp_dir/openscad.js"
install -Dm0755 "$tmp_dir/openscad.js" /usr/local/libexec/openscad/openscad.js
curl -fsSL "https://raw.githubusercontent.com/openscad/openscad/${OPENSCAD_SOURCE_REVISION}/COPYING" -o "$tmp_dir/COPYING"
printf '%s  %s\n' '${OPENSCAD_LICENSE_SHA256}' "$tmp_dir/COPYING" | sha256sum -c -
install -Dm0644 "$tmp_dir/COPYING" /usr/local/share/licenses/openscad/COPYING
openscad_version="$(openscad --version 2>&1 || true)"
grep -Fxq 'OpenSCAD version ${OPENSCAD_VERSION}' <<<"$openscad_version"
dpkg-query -W -f='\${Version}\n' povray | grep -F '${POVRAY_VERSION}'`;
}

function installImageMagickCommand(): string {
  return `set -euo pipefail
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL "https://codeload.github.com/ImageMagick/ImageMagick/tar.gz/${IMAGEMAGICK_COMMIT}" -o "$tmp_dir/imagemagick.tar.gz"
printf '%s  %s\n' '${IMAGEMAGICK_SOURCE_SHA256}' "$tmp_dir/imagemagick.tar.gz" | sha256sum -c -
mkdir "$tmp_dir/src"
tar -xzf "$tmp_dir/imagemagick.tar.gz" -C "$tmp_dir/src" --strip-components=1
cd "$tmp_dir/src"
./configure --prefix=/usr/local --disable-static --without-perl --with-fontconfig --with-freetype --with-heic --with-jpeg --with-png --with-rsvg --with-tiff --with-webp
make -j2
make install
ldconfig
magick -version | grep -F 'ImageMagick ${IMAGEMAGICK_VERSION}'`;
}

function installPdfInspectorCommand(): string {
  return `set -euo pipefail
npm install -g --omit=dev --no-audit --no-fund '@firecrawl/pdf-inspector@${PDF_INSPECTOR_VERSION}'
[[ "$(pdf-inspector --version)" == '${PDF_INSPECTOR_VERSION}' ]]`;
}

export const e2bToolboxTemplate = createE2BToolboxTemplate();
