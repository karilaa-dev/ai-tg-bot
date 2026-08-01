import { describe, expect, it } from "vitest";
import { Template } from "e2b";
import {
  E2B_TOOLBOX_APT_PACKAGES,
  E2B_TOOLBOX_CPU_COUNT,
  E2B_TOOLBOX_MEMORY_MB,
  E2B_TOOLBOX_PRODUCTION_REF,
  IMAGEMAGICK_COMMIT,
  IMAGEMAGICK_SOURCE_SHA256,
  OFFICECLI_AMD64_SHA256,
  OFFICECLI_ARM64_SHA256,
  OFFICECLI_VERSION,
  createE2BToolboxTemplate,
} from "../../e2b-template/template.js";

describe("E2B toolbox template definition", () => {
  it("uses E2B Base with the fixed production identity and resources", () => {
    expect(E2B_TOOLBOX_PRODUCTION_REF).toBe("ai-tg-bot-tools:production");
    expect(E2B_TOOLBOX_CPU_COUNT).toBe(2);
    expect(E2B_TOOLBOX_MEMORY_MB).toBe(2048);
    expect(Template.toDockerfile(createE2BToolboxTemplate())).toContain("FROM e2bdev/base");
  });

  it("contains the missing non-browser toolbox packages", () => {
    expect(E2B_TOOLBOX_APT_PACKAGES).toEqual(expect.arrayContaining([
      "dnsutils", "fd-find", "gnupg", "iproute2", "jq", "procps", "ripgrep",
      "sqlite3", "tree", "unzip", "zip", "zstd",
    ]));
    expect(E2B_TOOLBOX_APT_PACKAGES.join(" ")).not.toMatch(/chrom|playwright|puppeteer|selenium|browserless|docker/i);
  });

  it("pins OfficeCLI and ImageMagick supply-chain inputs", () => {
    expect(OFFICECLI_VERSION).toBe("1.0.142");
    expect(OFFICECLI_AMD64_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(OFFICECLI_ARM64_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(IMAGEMAGICK_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    expect(IMAGEMAGICK_SOURCE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });
});
