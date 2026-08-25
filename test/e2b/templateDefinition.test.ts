import fs from "node:fs/promises";
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
  OFFICECLI_DOCX_SKILL_SHA256,
  OFFICECLI_PPTX_SKILL_SHA256,
  OFFICECLI_SOURCE_REVISION,
  OFFICECLI_VERSION,
  PDF_INSPECTOR_VERSION,
  createE2BToolboxTemplate,
  e2bToolboxBuildRef,
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
      "build-essential", "curl", "dnsutils", "fd-find", "git", "gnupg", "iproute2", "jq", "openssh-client", "procps", "ripgrep",
      "poppler-utils", "sqlite3", "tree", "unzip", "zip", "zstd",
    ]));
    expect(E2B_TOOLBOX_APT_PACKAGES.join(" ")).not.toMatch(/chrom|playwright|puppeteer|selenium|browserless|docker/i);
  });

  it("pins OfficeCLI and ImageMagick supply-chain inputs", () => {
    expect(OFFICECLI_VERSION).toBe("1.0.144");
    expect(OFFICECLI_SOURCE_REVISION).toMatch(/^[a-f0-9]{40}$/);
    expect(OFFICECLI_AMD64_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(OFFICECLI_ARM64_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(OFFICECLI_DOCX_SKILL_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(OFFICECLI_PPTX_SKILL_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(PDF_INSPECTOR_VERSION).toBe("1.17.0");
    expect(IMAGEMAGICK_COMMIT).toMatch(/^[a-f0-9]{40}$/);
    expect(IMAGEMAGICK_SOURCE_SHA256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("installs and contracts the PDF document tools", async () => {
    const dockerfile = Template.toDockerfile(createE2BToolboxTemplate());
    expect(dockerfile).toContain("@firecrawl/pdf-inspector@1.17.0");
    const contract = await fs.readFile("e2b-template/assets/tool-contract.sh", "utf8");
    expect(contract).toContain("pdf-inspector detect");
    expect(contract).toContain('.pdfType == "Scanned"');
    expect(contract).toContain("pdftoppm");
    expect(contract).toContain("officecli view contract.docx text");
  });

  it("keeps immutable builds separate from production promotion", async () => {
    expect(e2bToolboxBuildRef("build-20260803-020000"))
      .toBe("ai-tg-bot-tools:build-20260803-020000");
    expect(() => e2bToolboxBuildRef("production:unexpected")).toThrow("contain no colon");
    expect(() => e2bToolboxBuildRef("production")).toThrow("reserved production tag");
    const source = await fs.readFile("e2b-template/build.ts", "utf8");
    expect(source).toContain("const exactRef = e2bToolboxBuildRef(buildTag)");
    expect(source.indexOf("const exactRef = e2bToolboxBuildRef(buildTag)"))
      .toBeLessThan(source.indexOf("Template.build"));
    expect(source).toContain("process.env.E2B_BUILD_TAG");
    expect(source).not.toContain("Template.assignTags");
    expect(source).not.toContain("buildInfo.buildId}`");

    const promotion = await fs.readFile("e2b-template/promote.ts", "utf8");
    expect(promotion).toContain("process.env.E2B_PROMOTE_TAG");
    expect(promotion.indexOf("validateE2BToolboxTemplate"))
      .toBeLessThan(promotion.indexOf("Template.assignTags"));
  });
});
