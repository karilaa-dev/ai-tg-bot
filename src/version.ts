import packageJson from "../package.json" with { type: "json" };

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

if (!SEMVER_PATTERN.test(packageJson.version)) {
  throw new Error(`package.json contains an invalid application version: ${packageJson.version}`);
}

export const APP_VERSION = packageJson.version;
