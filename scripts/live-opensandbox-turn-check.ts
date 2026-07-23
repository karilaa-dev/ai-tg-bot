import { createHash, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { unzipSync } from "fflate";
import { InputFile, type Api } from "grammy";
import { runTurn } from "../src/ai/run.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { createDatabase, type AppDatabase } from "../src/db/index.js";
import { createRepos, type Repos } from "../src/db/repos/index.js";
import type { FileRow, MessageRow, ThreadRow, UserRow } from "../src/db/types.js";
import { sha256Hex } from "../src/files/hash.js";
import { MAX_FILE_BYTES } from "../src/files/limits.js";
import { detectImageMediaType } from "../src/files/mediaType.js";
import { createLogger } from "../src/logger.js";
import {
  createOpenSandboxClient,
  createOpenSandboxClientProvider,
  type OpenSandboxClient,
} from "../src/opensandbox/client.js";
import { managedSandboxMetadata } from "../src/opensandbox/spec.js";
import { UserOpenSandboxRuntimeManager } from "../src/opensandbox/userRuntimeManager.js";
import { legacyCodexAuthCandidates, migrateLegacyCodexAuth } from "../src/pi/authMigration.js";
import { PiRuntimeManager } from "../src/pi/runtime.js";
import { botThreadWorkspace, botUserRoot, guestThreadWorkspace } from "../src/sandbox/paths.js";
import type { SandboxCommandResult } from "../src/sandbox/types.js";

const ARCHIVE_NAME = "hatsune-miku-wikimedia.zip";
const METADATA_NAME = "metadata.json";
const EXPECTED_IMAGES = 10;
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const USER_ID = 8_000_000_000_000_000 + randomInt(1, 1_000_000_000_000);
const DEPLOYMENT_ID = `live-turn-${randomUUID()}`;
const APPROVED_LICENSES = new Set([
  "CC0 1.0",
  "Public domain",
  "CC BY 2.0",
  "CC BY 2.5",
  "CC BY 3.0",
  "CC BY 4.0",
  "CC BY-SA 2.0",
  "CC BY-SA 2.5",
  "CC BY-SA 3.0",
  "CC BY-SA 4.0",
]);

const prompt = `
Use the real bash and create_file tools to prepare and deliver one ZIP archive.

Requirements:
1. Find and download exactly 10 distinct, clearly SFW artworks depicting Hatsune Miku from Wikimedia Commons only. Prefer illustrations, drawings, paintings, murals, sculptures, or other artwork rather than cosplay/event photography. Do not include sexualized, nude, suggestive, violent, or otherwise NSFW material.
2. Use Wikimedia Commons file pages and the MediaWiki API to verify each item. Download a PNG, JPEG, or WebP rendition from upload.wikimedia.org (a Commons thumbnail URL is acceptable and recommended to keep the archive below 20 MiB). Do not use HTML page URLs as image downloads.
3. Accept only these canonical licenses: ${[...APPROVED_LICENSES].join(", ")}.
4. Keep the archive flat. It must contain exactly 11 root-level files: 10 uniquely named image files and ${METADATA_NAME}. No directories or extra files.
5. Write ${METADATA_NAME} as UTF-8 JSON with exactly this shape:
   {"artworks":[{"filename":"...","title":"...","source_url":"https://commons.wikimedia.org/wiki/File:...","download_url":"https://upload.wikimedia.org/...","creator":"...","license":"CC BY-SA 4.0","sha256":"64 lowercase hex characters","description":"brief SFW description"}]}
   Include exactly one record per image. Strip HTML from creator/description fields. Hash the exact downloaded bytes.
6. Independently check in bash that every download is a real non-empty PNG/JPEG/WebP rather than HTML/JSON/error content, that all 10 SHA-256 values are unique and match metadata, and that all source/download URLs are Wikimedia URLs.
7. Create ${ARCHIVE_NAME} with the bash zip command, not Python or JavaScript. Keep it below 20 MiB. Then verify it with unzip -t and list its contents before delivery.
8. Call create_file exactly once with path "/${ARCHIVE_NAME}", name "${ARCHIVE_NAME}", MIME "application/zip", and delivery "document". Finish with a short confirmation.

Do not substitute generated images, non-Wikimedia sources, fewer or more than 10 images, another archive format, or prose instead of the requested file.
`.trim();

const baseConfig = loadConfig();
const sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ai-tg-bot-opensandbox-turn-"));
const isolatedAgentDir = path.join(sessionRoot, "pi");
const config = loadConfig({
  ...process.env,
  DB_URL: "sqlite::memory:",
  PI_CODING_AGENT_DIR: isolatedAgentDir,
  AGENT_SHARED_ROOT: baseConfig.AGENT_SHARED_ROOT,
  OPEN_SANDBOX_SHARED_HOST_ROOT: baseConfig.OPEN_SANDBOX_SHARED_HOST_ROOT,
  MANAGED_FILE_ROOT: path.join(sessionRoot, "managed-files"),
  BASH_WORKSPACE_ROOT: path.join(sessionRoot, "legacy-bash"),
  FILE_CACHE_DIR: path.join(sessionRoot, "file-cache"),
  OPEN_SANDBOX_DEPLOYMENT_ID: DEPLOYMENT_ID,
  OPEN_SANDBOX_IDLE_PAUSE_MS: "1000",
  BASH_TIMEOUT_MS: String(Math.max(baseConfig.BASH_TIMEOUT_MS, 300_000)),
  BASH_MAX_OUTPUT_CHARS: String(Math.max(baseConfig.BASH_MAX_OUTPUT_CHARS, 30_000)),
  PI_TURN_TIMEOUT_MS: String(Math.max(baseConfig.PI_TURN_TIMEOUT_MS, 900_000)),
});
const logger = createLogger(config);
let db: AppDatabase | undefined;
let commandRuntime: UserOpenSandboxRuntimeManager | undefined;
let pi: PiRuntimeManager | undefined;
let cleanupClient: OpenSandboxClient | undefined;
let failure: Error | undefined;

try {
  await seedIsolatedPiCredentials(baseConfig.PI_CODING_AGENT_DIR, isolatedAgentDir);
  await migrateLegacyCodexAuth({
    agentDir: isolatedAgentDir,
    logger,
    legacyAuthPaths: [
      path.join(path.resolve(baseConfig.PI_CODING_AGENT_DIR), "auth.json"),
      ...legacyCodexAuthCandidates(baseConfig.PI_CODING_AGENT_DIR),
    ],
  });

  db = createDatabase(config, logger);
  await db.migrate();
  const repos = createRepos(db.db, db.search);
  const user = await repos.users.ensure({ tgId: USER_ID, firstName: "OpenSandbox live check", lang: "en" });
  const thread = await repos.threads.create({
    userId: user.tg_id,
    topicId: null,
    title: "OpenSandbox live turn check",
  });
  commandRuntime = new UserOpenSandboxRuntimeManager({
    config,
    clientProvider: createOpenSandboxClientProvider(config),
    logger,
  });
  pi = new PiRuntimeManager({ config, db, repos, logger, commandRuntime });
  const telegram = createCapturingTelegramApi(user.tg_id);

  await runTurn({
    api: telegram.api,
    chatId: user.tg_id,
    config,
    db,
    repos,
    logger,
    user,
    thread,
    text: prompt,
    pi,
    resolveFile: async () => {
      throw new Error("The live turn did not provide Telegram input files.");
    },
    t: liveTranslation,
  });

  const captured = only(telegram.documents, "captured Telegram document");
  assert(captured.filename === ARCHIVE_NAME, `Telegram delivered unexpected filename: ${captured.filename}`);
  const archiveReport = inspectArchive(captured.bytes);
  const proof = await validatePersistenceAndToolUse({
    config,
    repos,
    user,
    thread,
    pi,
    commandRuntime,
    capturedArchive: captured.bytes,
    capturedDocument: captured,
    archiveReport,
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    provider: proof.provider,
    model: proof.model,
    archive: {
      name: ARCHIVE_NAME,
      bytes: captured.bytes.length,
      sha256: sha256Hex(captured.bytes),
      images: archiveReport.images.map((image) => ({
        filename: image.filename,
        mediaType: image.mediaType,
        bytes: image.bytes,
        sha256: image.sha256,
        sourceUrl: image.sourceUrl,
        license: image.license,
      })),
    },
    proof: {
      bashToolCalls: proof.bashToolCalls,
      createFileToolCalls: proof.createFileToolCalls,
      zipCommandObserved: proof.zipCommandObserved,
      unzipVerificationObserved: proof.unzipVerificationObserved,
      telegramDocuments: telegram.documents.length,
      telegramFileId: captured.fileId,
      persistedFileId: proof.persistedFileId,
      persistedMessageId: proof.persistedMessageId,
      persistedSessionFile: proof.sessionFile,
      workspaceResumeCheck: true,
    },
  }, null, 2)}\n`);
} catch (error) {
  failure = asError(error);
}

const cleanupErrors: Error[] = [];
for (const cleanup of [
  async () => pi?.dispose(),
  async () => commandRuntime?.dispose(),
  async () => db?.destroy(),
  async () => {
    cleanupClient = await createOpenSandboxClient(config);
    const sandboxes = await cleanupClient.list(managedSandboxMetadata(config));
    for (const sandbox of sandboxes) await cleanupClient.kill(sandbox.id);
  },
  async () => cleanupClient?.close(),
  async () => fs.rm(botUserRoot(config, USER_ID), { recursive: true, force: true }),
  async () => fs.rm(sessionRoot, { recursive: true, force: true }),
]) {
  try {
    await cleanup();
  } catch (error) {
    cleanupErrors.push(asError(error));
  }
}
if (cleanupErrors.length) {
  throw new AggregateError(
    failure ? [failure, ...cleanupErrors] : cleanupErrors,
    failure ? "OpenSandbox live turn check and cleanup failed" : "OpenSandbox live turn cleanup failed",
  );
}
if (failure) throw failure;

async function validatePersistenceAndToolUse(input: {
  config: AppConfig;
  repos: Repos;
  user: UserRow;
  thread: ThreadRow;
  pi: PiRuntimeManager;
  commandRuntime: UserOpenSandboxRuntimeManager;
  capturedArchive: Buffer;
  capturedDocument: CapturedDocument;
  archiveReport: ArchiveReport;
}): Promise<{
  provider: string;
  model: string;
  bashToolCalls: number;
  createFileToolCalls: number;
  zipCommandObserved: boolean;
  unzipVerificationObserved: boolean;
  persistedFileId: number;
  persistedMessageId: number;
  sessionFile: string;
}> {
  const runtime = await input.pi.runtime(input.thread, input.user);
  const calls = collectToolCalls(runtime.session.messages);
  const bashCalls = calls.filter((call) => call.name === "bash");
  const createFileCalls = calls.filter((call) => call.name === "create_file");
  assert(bashCalls.length > 0, "The provider did not call the real bash tool.");
  assert(createFileCalls.length === 1, `Expected exactly one create_file call, received ${createFileCalls.length}.`);
  const toolResults = collectToolResults(runtime.session.messages);
  const successfulBashIds = new Set(toolResults
    .filter((result) => result.name === "bash" && numberField(result.details, "exit_code") === 0)
    .map((result) => result.id));
  const zipCommandObserved = bashCalls.some((call) => successfulBashIds.has(call.id)
    && /(^|[;&|\n]\s*)zip(?:\s|$)/m.test(stringField(call.arguments, "script") ?? ""));
  const unzipVerificationObserved = bashCalls.some((call) => {
    if (!successfulBashIds.has(call.id)) return false;
    const script = stringField(call.arguments, "script") ?? "";
    return /(^|[;&|\n]\s*)unzip\s+(?:-[^\s]*t[^\s]*|[^\n;]*\s-t)(?:\s|$)/m.test(script)
      || /unzip\s+-t/i.test(script);
  });
  assert(zipCommandObserved, "No successful bash zip command was observed in the provider tool calls.");
  assert(unzipVerificationObserved, "No successful bash unzip test was observed in the provider tool calls.");
  assert(toolResults.some((result) => result.id === createFileCalls[0]!.id
    && result.name === "create_file" && numberField(result.details, "file_id") !== undefined),
    "The create_file call did not persist a successful file result in the Pi session.");

  const messages = await input.repos.messages.listThread(input.thread.id);
  assert(messages.length >= 2, "The turn did not persist both user and assistant messages.");
  const userMessage = messages.find((message) => message.role === "user");
  const assistantMessage = [...messages].reverse().find((message) => message.role === "assistant");
  assert(userMessage?.text_plain === prompt, "The exact live prompt was not persisted.");
  assert(Boolean(userMessage?.pi_entry_id), "The persisted user message has no Pi entry id.");
  assert(Boolean(assistantMessage?.pi_entry_id), "The persisted assistant message has no Pi entry id.");
  assert(Boolean(assistantMessage?.tg_message_id), "The assistant message has no Telegram delivery id.");

  const files = await input.repos.files.listForThreads([input.thread.id]);
  assert(files.length === 1, `Expected exactly one persisted outbound archive, received ${files.length}.`);
  const stored = only(files, "persisted archive");
  assert(stored.name === ARCHIVE_NAME, `Persisted file has unexpected name: ${stored.name}`);
  assert(stored.type === "other", `Persisted ZIP has unexpected stored type: ${stored.type}`);
  assert(stored.size === input.capturedArchive.length, "Persisted archive size differs from Telegram delivery.");
  assert(stored.content_sha256 === sha256Hex(input.capturedArchive), "Persisted archive hash differs from Telegram delivery.");
  assert(Boolean(stored.path), "Persisted archive has no managed durable path.");
  const storedBytes = await fs.readFile(stored.path!);
  assert(storedBytes.equals(input.capturedArchive), "Managed persisted archive bytes differ from Telegram delivery.");
  const attached = await input.repos.files.listForMessage(assistantMessage!.id);
  assert(attached.some((file) => file.id === stored.id), "Persisted archive is not attached to the assistant message.");
  const sources = await input.repos.files.listSources(stored.id);
  assert(sources.some((source) => source.transport === "telegram"
    && source.remote_key === input.capturedDocument.fileUniqueId), "Telegram delivery source was not persisted.");

  const workspaceArchive = path.join(botThreadWorkspace(input.config, input.user.tg_id, input.thread.id), ARCHIVE_NAME);
  const workspaceBytes = await fs.readFile(workspaceArchive);
  assert(workspaceBytes.equals(input.capturedArchive), "Persistent OpenSandbox workspace archive differs from delivered bytes.");

  await delay(input.config.OPEN_SANDBOX_IDLE_PAUSE_MS + 500);
  const resumeResult = await input.commandRuntime.execute({
    userId: input.user.tg_id,
    command: "bash",
    args: ["-c", `set -eu; test -f ${shellQuote(ARCHIVE_NAME)}; unzip -tq ${shellQuote(ARCHIVE_NAME)} >/dev/null; sha256sum ${shellQuote(ARCHIVE_NAME)}`, "bash"],
    env: { TZ: "UTC" },
    stdin: "",
    workingDir: guestThreadWorkspace(input.thread.id),
    timeoutMs: 60_000,
    maxOutputChars: 4000,
  });
  assertCommandSuccess(resumeResult, "OpenSandbox pause/resume persistence check");
  assert(resumeResult.stdout.trim().split(/\s+/)[0] === sha256Hex(input.capturedArchive),
    "OpenSandbox resume check returned a different archive hash.");

  const storedThread = await input.repos.threads.get(input.thread.id);
  assert(Boolean(storedThread?.pi_session_file), "Thread did not persist a Pi session file.");
  const sessionFile = storedThread!.pi_session_file!;
  const sessionText = await fs.readFile(sessionFile, "utf8");
  assert(sessionText.includes(ARCHIVE_NAME), "Persistent Pi session does not mention the requested archive.");
  assert(sessionText.includes('"name":"bash"') || sessionText.includes('"toolName":"bash"'),
    "Persistent Pi session does not contain the bash tool call.");
  assert(sessionText.includes('"name":"create_file"') || sessionText.includes('"toolName":"create_file"'),
    "Persistent Pi session does not contain the create_file tool call.");

  const assistant = lastAssistant(runtime.session.messages);
  assert(Boolean(assistant), "Pi session has no final assistant message.");
  assert(assistant!.stopReason !== "error", assistant!.errorMessage || "Pi assistant stopped with an error.");
  assert(input.archiveReport.images.length === EXPECTED_IMAGES, "Archive report image count changed unexpectedly.");
  return {
    provider: assistant!.provider,
    model: assistant!.model,
    bashToolCalls: bashCalls.length,
    createFileToolCalls: createFileCalls.length,
    zipCommandObserved,
    unzipVerificationObserved,
    persistedFileId: stored.id,
    persistedMessageId: assistantMessage!.id,
    sessionFile,
  };
}

type ArtworkMetadata = {
  filename: string;
  title: string;
  source_url: string;
  download_url: string;
  creator: string;
  license: string;
  sha256: string;
  description: string;
};

type ArchiveImageReport = {
  filename: string;
  mediaType: string;
  bytes: number;
  sha256: string;
  sourceUrl: string;
  license: string;
};

type ArchiveReport = { images: ArchiveImageReport[] };

function inspectArchive(bytes: Buffer): ArchiveReport {
  assert(bytes.length > 0, "Captured ZIP is empty.");
  assert(bytes.length < MAX_FILE_BYTES, `Captured ZIP is not below 20 MiB (${bytes.length} bytes).`);
  const centralEntries = parseZipCentralDirectory(bytes);
  assert(centralEntries.length === EXPECTED_IMAGES + 1,
    `ZIP must contain exactly 11 files, received ${centralEntries.length}.`);
  for (const entry of centralEntries) assertSafeFlatArchivePath(entry.name);
  assert(new Set(centralEntries.map((entry) => entry.name)).size === centralEntries.length,
    "ZIP contains duplicate entry names.");
  const totalUncompressed = centralEntries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
  assert(totalUncompressed <= MAX_UNCOMPRESSED_BYTES,
    `ZIP declares too much uncompressed data (${totalUncompressed} bytes).`);

  const extracted = unzipSync(bytes);
  const names = Object.keys(extracted).sort();
  assert(names.length === centralEntries.length, "ZIP extraction entry count differs from its central directory.");
  assert(names.includes(METADATA_NAME), `ZIP is missing ${METADATA_NAME}.`);
  const imageNames = names.filter((name) => name !== METADATA_NAME);
  assert(imageNames.length === EXPECTED_IMAGES, `ZIP contains ${imageNames.length} image files instead of 10.`);

  const metadataBytes = extracted[METADATA_NAME];
  assert(Boolean(metadataBytes), `Could not extract ${METADATA_NAME}.`);
  const metadataText = Buffer.from(metadataBytes!).toString("utf8");
  assert(!metadataText.includes("\0"), "metadata.json contains NUL bytes.");
  const parsed = parseJsonObject(metadataText, METADATA_NAME);
  const artworks = parsed.artworks;
  assert(Array.isArray(artworks), "metadata.json must contain an artworks array.");
  assert(artworks.length === EXPECTED_IMAGES, `metadata.json contains ${artworks.length} records instead of 10.`);
  assert(Object.keys(parsed).length === 1, "metadata.json must contain only the artworks top-level property.");

  const records = artworks.map((value, index) => parseArtwork(value, index));
  assertUnique(records.map((record) => record.filename), "metadata filenames");
  assertUnique(records.map((record) => record.source_url), "Wikimedia source URLs");
  assertUnique(records.map((record) => record.download_url), "Wikimedia download URLs");
  assertUnique(records.map((record) => record.sha256), "metadata SHA-256 hashes");
  assertSameSet(records.map((record) => record.filename), imageNames, "metadata filenames and ZIP image entries");

  const reports: ArchiveImageReport[] = [];
  for (const record of records) {
    const raw = extracted[record.filename];
    assert(Boolean(raw), `Metadata references missing image ${record.filename}.`);
    const image = Buffer.from(raw!);
    assert(image.length >= 512, `${record.filename} is implausibly small (${image.length} bytes).`);
    assert(image.length <= MAX_FILE_BYTES, `${record.filename} exceeds the per-file limit.`);
    rejectErrorPayload(record.filename, image);
    const mediaType = validateImage(record.filename, image);
    const hash = sha256Hex(image);
    assert(hash === record.sha256, `${record.filename} SHA-256 does not match metadata.`);
    reports.push({
      filename: record.filename,
      mediaType,
      bytes: image.length,
      sha256: hash,
      sourceUrl: record.source_url,
      license: record.license,
    });
  }
  assertUnique(reports.map((report) => report.sha256), "actual image SHA-256 hashes");
  return { images: reports.sort((left, right) => left.filename.localeCompare(right.filename)) };
}

function parseArtwork(value: unknown, index: number): ArtworkMetadata {
  const record = objectValue(value, `metadata artwork ${index + 1}`);
  const expected = ["creator", "description", "download_url", "filename", "license", "sha256", "source_url", "title"];
  assertSameSet(Object.keys(record), expected, `metadata artwork ${index + 1} fields`);
  const artwork: ArtworkMetadata = {
    filename: requiredString(record, "filename"),
    title: requiredString(record, "title"),
    source_url: requiredString(record, "source_url"),
    download_url: requiredString(record, "download_url"),
    creator: requiredString(record, "creator"),
    license: requiredString(record, "license"),
    sha256: requiredString(record, "sha256"),
    description: requiredString(record, "description"),
  };
  assertSafeFlatArchivePath(artwork.filename);
  assert(artwork.filename !== METADATA_NAME, "An artwork filename collides with metadata.json.");
  assert(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(artwork.source_url),
    `Source URL is not a Wikimedia Commons file page: ${artwork.source_url}`);
  assertWikimediaUrl(artwork.download_url, "download URL");
  assert(APPROVED_LICENSES.has(artwork.license), `Unapproved or non-canonical license: ${artwork.license}`);
  assert(/^[a-f0-9]{64}$/.test(artwork.sha256), `Invalid SHA-256 for ${artwork.filename}.`);
  assert(!/<[^>]+>/.test(`${artwork.creator}\n${artwork.description}`),
    `Metadata for ${artwork.filename} contains HTML.`);
  const subjectText = `${artwork.title}\n${artwork.description}\n${decodeURIComponentSafe(artwork.source_url)}`;
  assert(/\bmiku\b/i.test(subjectText), `Metadata does not identify ${artwork.filename} as a Hatsune Miku artwork.`);
  assert(!containsUnsafeContentTerms(subjectText),
    `Metadata for ${artwork.filename} contains an NSFW/unsafe content term.`);
  return artwork;
}

function parseZipCentralDirectory(bytes: Buffer): Array<{
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}> {
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  assert(disk === 0 && centralDisk === 0 && entriesOnDisk === entryCount, "Multi-disk ZIP archives are not allowed.");
  assert(entryCount > 0 && entryCount <= 100, `Unreasonable ZIP entry count: ${entryCount}.`);
  assert(centralOffset !== 0xffffffff && centralSize !== 0xffffffff, "ZIP64 archives are not accepted by this check.");
  assert(centralOffset + centralSize <= eocd, "ZIP central directory lies outside the archive.");

  const entries: Array<{ name: string; compressedSize: number; uncompressedSize: number }> = [];
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    assert(offset + 46 <= bytes.length && bytes.readUInt32LE(offset) === 0x02014b50,
      `Invalid ZIP central directory entry ${index + 1}.`);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    assert(end <= bytes.length, `Truncated ZIP central directory entry ${index + 1}.`);
    assert((flags & 0x1) === 0, "Encrypted ZIP entries are not allowed.");
    assert(method === 0 || method === 8, `Unsupported ZIP compression method ${method}.`);
    assert(compressedSize !== 0xffffffff && uncompressedSize !== 0xffffffff, "ZIP64 entries are not allowed.");
    const unixMode = externalAttributes >>> 16;
    assert((unixMode & 0xf000) !== 0xa000, "Symbolic links are not allowed in the ZIP.");
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    assert(!name.endsWith("/"), `Directory entries are not allowed in the flat ZIP: ${name}`);
    entries.push({ name, compressedSize, uncompressedSize });
    offset = end;
  }
  assert(offset === centralOffset + centralSize, "ZIP central directory size does not match parsed entries.");
  return entries;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = bytes.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  throw new Error("ZIP end-of-central-directory record was not found.");
}

function validateImage(filename: string, bytes: Buffer): string {
  const mediaType = detectImageMediaType(bytes);
  assert(Boolean(mediaType), `${filename} is not a recognized PNG, JPEG, or WebP image.`);
  const extension = path.extname(filename).toLowerCase();
  const expectedExtensions: Record<string, string[]> = {
    "image/png": [".png"],
    "image/jpeg": [".jpg", ".jpeg"],
    "image/webp": [".webp"],
  };
  assert(expectedExtensions[mediaType!]?.includes(extension),
    `${filename} extension does not match detected media type ${mediaType}.`);
  if (mediaType === "image/png") validatePng(filename, bytes);
  else if (mediaType === "image/jpeg") validateJpeg(filename, bytes);
  else validateWebp(filename, bytes);
  return mediaType!;
}

function validatePng(filename: string, bytes: Buffer): void {
  assert(bytes.length >= 33 && bytes.subarray(12, 16).toString("ascii") === "IHDR", `${filename} has no PNG IHDR.`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert(width > 0 && height > 0 && width <= 50_000 && height <= 50_000, `${filename} has invalid PNG dimensions.`);
  assert(bytes.includes(Buffer.from("IEND", "ascii")), `${filename} has no PNG IEND chunk.`);
}

function validateJpeg(filename: string, bytes: Buffer): void {
  assert(bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9, `${filename} has no JPEG end marker.`);
  let offset = 2;
  let dimensionsFound = false;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    assert(offset + 2 <= bytes.length, `${filename} has a truncated JPEG segment.`);
    const length = bytes.readUInt16BE(offset);
    assert(length >= 2 && offset + length <= bytes.length, `${filename} has an invalid JPEG segment length.`);
    if (isJpegStartOfFrame(marker)) {
      assert(length >= 7, `${filename} has a truncated JPEG frame header.`);
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      assert(width > 0 && height > 0, `${filename} has invalid JPEG dimensions.`);
      dimensionsFound = true;
    }
    offset += length;
  }
  assert(dimensionsFound, `${filename} has no JPEG start-of-frame dimensions.`);
}

function isJpegStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function validateWebp(filename: string, bytes: Buffer): void {
  const declaredSize = bytes.readUInt32LE(4) + 8;
  assert(declaredSize <= bytes.length && declaredSize >= 20, `${filename} has an invalid WebP RIFF size.`);
  let offset = 12;
  let dimensionsFound = false;
  while (offset + 8 <= declaredSize) {
    const kind = bytes.subarray(offset, offset + 4).toString("ascii");
    const size = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    assert(payload + size <= bytes.length, `${filename} has a truncated WebP chunk.`);
    if (kind === "VP8X" && size >= 10) {
      const width = readUInt24LE(bytes, payload + 4) + 1;
      const height = readUInt24LE(bytes, payload + 7) + 1;
      assert(width > 0 && height > 0, `${filename} has invalid WebP VP8X dimensions.`);
      dimensionsFound = true;
    } else if (kind === "VP8 " && size >= 10 && bytes.subarray(payload + 3, payload + 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      const width = bytes.readUInt16LE(payload + 6) & 0x3fff;
      const height = bytes.readUInt16LE(payload + 8) & 0x3fff;
      assert(width > 0 && height > 0, `${filename} has invalid WebP VP8 dimensions.`);
      dimensionsFound = true;
    } else if (kind === "VP8L" && size >= 5 && bytes[payload] === 0x2f) {
      const packed = bytes.readUInt32LE(payload + 1);
      const width = (packed & 0x3fff) + 1;
      const height = ((packed >>> 14) & 0x3fff) + 1;
      assert(width > 0 && height > 0, `${filename} has invalid WebP VP8L dimensions.`);
      dimensionsFound = true;
    }
    offset = payload + size + (size % 2);
  }
  assert(dimensionsFound, `${filename} has no valid WebP image dimensions.`);
}

function rejectErrorPayload(filename: string, bytes: Buffer): void {
  const prefix = bytes.subarray(0, Math.min(bytes.length, 1024)).toString("utf8").trimStart().toLowerCase();
  assert(!prefix.startsWith("<!doctype html") && !prefix.startsWith("<html") && !prefix.startsWith("<?xml"),
    `${filename} contains an HTML/XML payload instead of a raster image.`);
  assert(!prefix.startsWith("{") && !prefix.startsWith("["), `${filename} contains a JSON payload instead of an image.`);
  assert(!/^\s*(error|not found|access denied|forbidden|rate limit)/i.test(prefix),
    `${filename} contains an error payload instead of an image.`);
}

function assertSafeFlatArchivePath(name: string): void {
  assert(Boolean(name) && !name.includes("\0"), "ZIP entry has an empty or NUL-containing path.");
  assert(!name.includes("\\"), `ZIP entry uses a backslash path: ${name}`);
  assert(!path.posix.isAbsolute(name) && !/^[a-z]:/i.test(name), `ZIP entry has an absolute path: ${name}`);
  const normalized = path.posix.normalize(name);
  assert(normalized === name && normalized !== "." && normalized !== ".." && !normalized.startsWith("../"),
    `ZIP entry has an unsafe path: ${name}`);
  assert(!name.includes("/"), `ZIP must be flat but contains a nested path: ${name}`);
}

function assertWikimediaUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  assert(url.protocol === "https:", `${label} is not HTTPS: ${value}`);
  assert(url.hostname === "upload.wikimedia.org" || url.hostname === "commons.wikimedia.org",
    `${label} is not hosted by Wikimedia Commons: ${value}`);
}

function containsUnsafeContentTerms(value: string): boolean {
  return /\b(?:nsfw|nude|nudity|naked|porn|pornographic|hentai|erotic|sexual|sexually|fetish|gore|guro|explicit|suggestive|lingerie|underwear)\b/i.test(value);
}

async function seedIsolatedPiCredentials(sourceAgentDir: string, targetAgentDir: string): Promise<void> {
  await fs.mkdir(targetAgentDir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json"]) {
    const source = path.join(path.resolve(sourceAgentDir), name);
    const target = path.join(targetAgentDir, name);
    try {
      await fs.copyFile(source, target);
      if (name === "auth.json") await fs.chmod(target, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type CapturedDocument = {
  chatId: number;
  filename: string;
  bytes: Buffer;
  fileId: string;
  fileUniqueId: string;
};

function createCapturingTelegramApi(expectedChatId: number): { api: Api; documents: CapturedDocument[] } {
  const documents: CapturedDocument[] = [];
  let nextMessageId = 50_000;
  const assertChat = (chatId: number | undefined) => {
    assert(chatId === expectedChatId, `Fake Telegram API received unexpected chat id ${String(chatId)}.`);
  };
  const message = () => ({
    message_id: nextMessageId++,
    date: Math.floor(Date.now() / 1000),
    chat: { id: expectedChatId, type: "private" as const, first_name: "OpenSandbox live check" },
  });
  const api = {
    raw: {
      sendRichMessage: async (payload: { chat_id?: number }) => {
        assertChat(payload.chat_id);
        return message();
      },
      sendRichMessageDraft: async (payload: { chat_id?: number }) => {
        assertChat(payload.chat_id);
        return true;
      },
    },
    sendMessage: async (chatId: number) => {
      assertChat(chatId);
      return message();
    },
    editMessageText: async (chatId: number) => {
      assertChat(chatId);
      return message();
    },
    sendChatAction: async (chatId: number) => {
      assertChat(chatId);
      return true;
    },
    sendDocument: async (chatId: number, document: InputFile) => {
      assertChat(chatId);
      assert(document instanceof InputFile, "Telegram sendDocument did not receive a grammY InputFile.");
      const bytes = await inputFileBytes(document);
      const filename = document.filename ?? "document.bin";
      const hash = sha256Hex(bytes);
      const fileId = `fake-document-${hash.slice(0, 24)}`;
      const fileUniqueId = `fake-unique-${hash.slice(0, 24)}`;
      documents.push({ chatId, filename, bytes, fileId, fileUniqueId });
      return { ...message(), document: { file_id: fileId, file_unique_id: fileUniqueId, file_name: filename, file_size: bytes.length } };
    },
    sendMediaGroup: async () => {
      throw new Error("The live check expected one document, not a media group.");
    },
    sendPhoto: async () => {
      throw new Error("The live check expected ZIP document delivery, not a photo.");
    },
  } as unknown as Api;
  return { api, documents };
}

async function inputFileBytes(input: InputFile): Promise<Buffer> {
  const raw = await input.toRaw();
  if (raw instanceof Uint8Array) return Buffer.from(raw);
  const chunks: Buffer[] = [];
  for await (const chunk of raw as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function collectToolCalls(messages: AgentMessage[]): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [];
    return message.content.flatMap((part) => {
      if (part.type !== "toolCall") return [];
      return [{ id: part.id, name: part.name, arguments: objectValue(part.arguments, `${part.name} arguments`) }];
    });
  });
}

function collectToolResults(messages: AgentMessage[]): Array<{ id: string; name: string; details: Record<string, unknown> }> {
  return messages.flatMap((message) => {
    if (message.role !== "toolResult") return [];
    const direct = objectOrUndefined((message as unknown as { details?: unknown }).details);
    if (direct) return [{ id: message.toolCallId, name: message.toolName, details: direct }];
    for (const part of message.content) {
      if (part.type !== "text") continue;
      try {
        const parsed = objectOrUndefined(JSON.parse(part.text));
        if (parsed) return [{ id: message.toolCallId, name: message.toolName, details: parsed }];
      } catch {
        // Pi tool adapters normally persist JSON text; ignore non-JSON presentation text.
      }
    }
    return [{ id: message.toolCallId, name: message.toolName, details: {} }];
  });
}

function lastAssistant(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function liveTranslation(key: string, params?: Record<string, string | number>): string {
  const fixed: Record<string, string> = {
    "thinking-placeholder": "Working...",
    "thinking-done": "Done",
    "error-generic": "The live turn failed.",
    "empty-answer": "Done.",
    "thinking-final-tools": "Tools",
    "image-generated-done": "Image generated.",
    "image-generated-ready": "Image ready.",
  };
  if (fixed[key]) return fixed[key];
  return params ? `${key} ${JSON.stringify(params)}` : key;
}

function assertCommandSuccess(result: SandboxCommandResult, label: string): void {
  if (result.exitCode === 0 && !result.timedOut && !result.error) return;
  throw new Error(`${label} failed: ${JSON.stringify(result)}`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(text), label);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${String(error)}`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  const record = objectOrUndefined(value);
  if (!record) throw new Error(`${label} must be a JSON object.`);
  return record;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  assert(typeof value === "string" && value.trim().length > 0, `metadata field ${key} must be a non-empty string.`);
  return value.trim();
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function assertSameSet(actual: string[], expected: string[], label: string): void {
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(left.length === right.length && left.every((value, index) => value === right[index]),
    `${label} differ: ${JSON.stringify({ actual: left, expected: right })}`);
}

function assertUnique(values: string[], label: string): void {
  assert(new Set(values).size === values.length, `${label} are not unique.`);
}

function only<T>(values: T[], label: string): T {
  assert(values.length === 1, `Expected exactly one ${label}, received ${values.length}.`);
  return values[0]!;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
