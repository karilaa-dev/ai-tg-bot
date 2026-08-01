import { fileURLToPath } from "node:url";
import { Template, type TemplateClass } from "e2b";

export const E2B_TOOLBOX_TEMPLATE_NAME = "ai-tg-bot-tools";
export const E2B_TOOLBOX_PRODUCTION_TAG = "production";
export const E2B_TOOLBOX_PRODUCTION_REF = `${E2B_TOOLBOX_TEMPLATE_NAME}:${E2B_TOOLBOX_PRODUCTION_TAG}`;
export const E2B_TOOLBOX_CPU_COUNT = 2;
export const E2B_TOOLBOX_MEMORY_MB = 2048;

export const OFFICECLI_VERSION = "1.0.142";
export const OFFICECLI_SOURCE_REVISION = "e56ee7f3595cb81ff2c87cf83a32a44bd71ed07d";
export const OFFICECLI_AMD64_SHA256 = "f78563abc13cf70dcd420644019d2f11dc36ea2957ac738613a6911d652b5541";
export const OFFICECLI_ARM64_SHA256 = "260cdccd27f2e25902e9436e5e971c0ca5348ae3d36a54a3fbd794c452ba13f7";
export const OFFICECLI_DOCX_SKILL_SHA256 = "1da56ed53a308222ab2516a2974ae98c6703b7d504fa5158348c39a18e85a4f1";
export const OFFICECLI_PPTX_SKILL_SHA256 = "0d53192751d5770984f16f3c34f9923377651555c667150d7f96e16e8c9757b3";

export const IMAGEMAGICK_VERSION = "7.1.2-29";
export const IMAGEMAGICK_COMMIT = "360eda553586e389c9c725fc49df94f209a8a3c7";
export const IMAGEMAGICK_SOURCE_SHA256 = "429ddf8e4235eb09c09b92dbe71f3d79cae3304be8bc7acb5a37bd61ede663d9";

export const E2B_TOOLBOX_APT_PACKAGES = [
  "autoconf",
  "automake",
  "bzip2",
  "ca-certificates",
  "coreutils",
  "dnsutils",
  "fd-find",
  "file",
  "findutils",
  "gawk",
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
    .makeDir(["/usr/local/libexec", "/usr/local/share/officecli/skills/officecli-docx", "/usr/local/share/officecli/skills/officecli-pptx", "/usr/local/share/licenses/officecli"], {
      user: "root",
      mode: 0o755,
    })
    .makeDir("/home/user/workspace", { user: "user", mode: 0o700 })
    .copyItems([
      { src: "assets/tool-contract.sh", dest: "/usr/local/bin/tool-contract.sh", user: "root", mode: 0o755 },
      { src: "assets/officecli", dest: "/usr/local/bin/officecli", user: "root", mode: 0o755 },
    ])
    .makeSymlink("/usr/bin/fdfind", "/usr/local/bin/fd", { user: "root", force: true })
    .makeSymlink("/usr/local/bin/python3", "/usr/local/bin/python", { user: "root", force: true })
    .runCmd(installImageMagickCommand(), { user: "root" })
    .runCmd(installOfficeCliCommand(), { user: "root" })
    .runCmd("/usr/local/bin/tool-contract.sh", { user: "user" })
    .setWorkdir("/home/user/workspace")
    .setUser("user");
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

function installOfficeCliCommand(): string {
  return `set -euo pipefail
case "$(dpkg --print-architecture)" in
  amd64) officecli_asset='officecli-linux-x64'; officecli_sha='${OFFICECLI_AMD64_SHA256}' ;;
  arm64) officecli_asset='officecli-linux-arm64'; officecli_sha='${OFFICECLI_ARM64_SHA256}' ;;
  *) printf 'Unsupported OfficeCLI architecture: %s\n' "$(dpkg --print-architecture)" >&2; exit 1 ;;
esac
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
curl -fsSL "https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/$officecli_asset" -o "$tmp_dir/officecli"
printf '%s  %s\n' "$officecli_sha" "$tmp_dir/officecli" | sha256sum -c -
install -Dm0755 "$tmp_dir/officecli" /usr/local/libexec/officecli-bin
for skill in docx pptx; do
  curl -fsSL "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/${OFFICECLI_SOURCE_REVISION}/skills/officecli-$skill/SKILL.md" -o "$tmp_dir/officecli-$skill.md"
done
printf '%s  %s\n' '${OFFICECLI_DOCX_SKILL_SHA256}' "$tmp_dir/officecli-docx.md" | sha256sum -c -
printf '%s  %s\n' '${OFFICECLI_PPTX_SKILL_SHA256}' "$tmp_dir/officecli-pptx.md" | sha256sum -c -
install -Dm0644 "$tmp_dir/officecli-docx.md" /usr/local/share/officecli/skills/officecli-docx/SKILL.md
install -Dm0644 "$tmp_dir/officecli-pptx.md" /usr/local/share/officecli/skills/officecli-pptx/SKILL.md
for legal_file in LICENSE NOTICE; do
  curl -fsSL "https://raw.githubusercontent.com/iOfficeAI/OfficeCLI/${OFFICECLI_SOURCE_REVISION}/$legal_file" -o "$tmp_dir/$legal_file"
  install -Dm0644 "$tmp_dir/$legal_file" "/usr/local/share/licenses/officecli/$legal_file"
done
/usr/local/bin/officecli --version`;
}

export const e2bToolboxTemplate = createE2BToolboxTemplate();
