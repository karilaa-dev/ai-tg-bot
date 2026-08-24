import type { ToolBuildInput } from "../ai/tools/types.js";
import { threadChainScope } from "../memory/retrieval.js";
import type { SandboxThreadFile } from "../sandbox/types.js";

export async function resolveThreadFileDescriptors(
  input: Pick<ToolBuildInput, "repos" | "thread" | "maxMessageId">,
  _signal?: AbortSignal,
  selectedFileIds?: number[],
): Promise<SandboxThreadFile[]> {
  const scope = await threadChainScope(input.repos, input.thread, input.maxMessageId);
  const selected = selectedFileIds
    ? [...new Set(selectedFileIds)].filter((fileId) => scope.fileIds.includes(fileId))
    : scope.fileIds;
  const [files, refs] = await Promise.all([
    input.repos.files.listByIds(selected),
    input.repos.files.listTelegramFileRefs(selected),
  ]);
  const refsByFile = new Map<number, typeof refs>();
  for (const ref of refs) {
    const list = refsByFile.get(ref.file_id) ?? [];
    list.push(ref);
    refsByFile.set(ref.file_id, list);
  }
  return files.map((file) => ({
    fileId: file.id,
    messageId: file.message_id,
    name: file.name,
    mimeType: file.mime_type,
    expectedSize: file.size,
    expectedSha256: file.content_sha256,
    telegramRefs: (refsByFile.get(file.id) ?? []).map((ref) => ({
      id: ref.id,
      telegramFileId: ref.telegram_file_id,
      telegramSize: ref.telegram_size,
      width: ref.width,
      height: ref.height,
      direction: ref.direction,
      mediaKind: ref.media_kind,
      isPrimary: ref.is_primary === 1,
      lastSeenAt: ref.last_seen_at,
    })),
  })).filter((file) => file.telegramRefs.some((ref) => ref.isPrimary));
}
