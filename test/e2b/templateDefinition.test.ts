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
  OPENSCAD_LICENSE_SHA256,
  OPENSCAD_NODE_SHA256,
  OPENSCAD_SOURCE_REVISION,
  OPENSCAD_VERSION,
  PDF_INSPECTOR_VERSION,
  POVRAY_VERSION,
  createE2BToolboxTemplate,
  e2bToolboxBuildRef,
} from "../../e2b-template/template.js";
import {
  E2B_TOOLBOX_RELEASE_REF,
  E2B_TOOLBOX_RELEASE_TAG,
} from "../../src/e2b/templateIdentity.js";

describe("E2B toolbox template definition", () => {
  it("uses E2B Base with versioned and production identities plus fixed resources", () => {
    expect(E2B_TOOLBOX_PRODUCTION_REF).toBe("ai-tg-bot-tools:production");
    expect(E2B_TOOLBOX_RELEASE_TAG).toBe("v2.0.4");
    expect(E2B_TOOLBOX_RELEASE_REF).toBe("ai-tg-bot-tools:v2.0.4");
    expect(E2B_TOOLBOX_CPU_COUNT).toBe(2);
    expect(E2B_TOOLBOX_MEMORY_MB).toBe(2048);
    expect(Template.toDockerfile(createE2BToolboxTemplate())).toContain("FROM e2bdev/base");
  });

  it("contains the missing non-browser toolbox packages", () => {
    expect(E2B_TOOLBOX_APT_PACKAGES).toEqual(expect.arrayContaining([
      "build-essential", "curl", "dnsutils", "fd-find", "git", "gnupg", "iproute2", "jq", "openssh-client", "procps", "ripgrep",
      "poppler-utils", "povray", "sqlite3", "tree", "unzip", "zip", "zstd",
    ]));
    expect(E2B_TOOLBOX_APT_PACKAGES).not.toEqual(expect.arrayContaining([
      "libgl1-mesa-dri", "openscad", "xauth", "xvfb",
    ]));
    expect(E2B_TOOLBOX_APT_PACKAGES.join(" ")).not.toMatch(/chrom|playwright|puppeteer|selenium|browserless|docker/i);
  });

  it("pins OfficeCLI and ImageMagick supply-chain inputs", () => {
    expect(OFFICECLI_VERSION).toBe("1.0.145");
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

  it("installs and smoke-tests the headless OpenSCAD build command", async () => {
    const dockerfile = Template.toDockerfile(createE2BToolboxTemplate());
    expect(OPENSCAD_VERSION).toBe("2026.08.27");
    expect(OPENSCAD_SOURCE_REVISION).toBe("8020f9208e6c023086837ea07deaa9210bf50729");
    expect(OPENSCAD_NODE_SHA256).toBe("6fb5a3bfd5580b6c65d559552b79d6c4bac456d2956864e0b5432a1a28ee4508");
    expect(OPENSCAD_LICENSE_SHA256).toMatch(/^[a-f0-9]{64}$/u);
    expect(POVRAY_VERSION).toBe("3.7.0.10");
    expect(dockerfile).toContain(`OpenSCAD-${OPENSCAD_VERSION}-WebAssembly-node.zip`);
    expect(dockerfile).toContain(OPENSCAD_NODE_SHA256);
    expect(dockerfile).toContain("openscad-pov-render.mjs");
    expect(dockerfile).toContain("openscad-build");
    const contract = await fs.readFile("e2b-template/assets/tool-contract.sh", "utf8");
    expect(contract).toContain("openscad-build preview");
    expect(contract).toContain("openscad-build final");
    expect(contract).toContain("test.preview.png");
    expect(contract).toContain("test.final.png");
    expect(contract).toContain("test.stl");
    expect(contract).toContain('[[ ! -e "${tmp_dir}/openscad/test.3mf" ]]');
    expect(contract).toContain("PNG 900 675");
    expect(contract).toContain("PNG 1200 900");
    expect(contract).toContain("Xvfb xvfb-run");
    const wrapper = await fs.readFile("e2b-template/assets/openscad-build", "utf8");
    expect(wrapper).not.toMatch(/xvfb|DISPLAY|LIBGL/iu);
    expect(wrapper).toContain("binstl");
    expect(wrapper).not.toContain("3mf");
  });

  it("keeps immutable builds separate from production promotion", async () => {
    expect(e2bToolboxBuildRef("build-20260803-020000"))
      .toBe("ai-tg-bot-tools:build-20260803-020000");
    expect(() => e2bToolboxBuildRef("production:unexpected")).toThrow("contain no colon");
    expect(() => e2bToolboxBuildRef("production")).toThrow("reserved production tag");
    const source = await fs.readFile("e2b-template/build.ts", "utf8");
    expect(source).toContain("const exactRef = e2bToolboxBuildRef(buildTag)");
    expect(source.indexOf("const exactRef = e2bToolboxBuildRef(buildTag)"))
      .toBeLessThan(source.indexOf("const buildInfo = await buildE2BToolboxTemplate"));
    expect(source).toContain("process.env.E2B_BUILD_TAG");
    expect(source).not.toContain("Template.assignTags");
    expect(source).not.toContain("buildInfo.buildId}`");

    const promotion = await fs.readFile("e2b-template/promote.ts", "utf8");
    expect(promotion).toContain("process.env.E2B_PROMOTE_TAG");
    expect(promotion.indexOf("validateE2BToolboxTemplate"))
      .toBeLessThan(promotion.indexOf("Template.assignTags"));
  });

  it("packages template assets for the manual release command", async () => {
    const packageJson = JSON.parse(await fs.readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.build).toContain("copy-e2b-template-assets");
    expect(packageJson.scripts["e2b:release"]).toBe("tsx e2b-template/release.ts");

    const copySource = await fs.readFile("scripts/copy-e2b-template-assets.ts", "utf8");
    expect(copySource).toContain("e2b-template/assets");
    expect(copySource).toContain("dist/e2b-template/assets");
    expect(copySource).toContain("openscad-build");
  });
});
