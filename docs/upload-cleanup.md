# Upload cleanup batching

Abandoned website uploads are reclaimed by `UploadRecovery`, which retries owed removals from `web_upload_cleanup` in batches of 25. Each stored file is revoked by `LocalFileStore`: an empty directory is installed at its UUID path as a permanent fence, staging copies named `<uuid>.<writer uuid>.tmp` are removed, and the directory is synced. Before this change every key listed the whole attachment directory and synced it separately, so one batch cost 25 full listings and 25 directory syncs.

## Measurement

`scripts/benchmark-upload-cleanup.ts` revokes one batch of 25 abandoned keys, each with a stranded staging copy, in a directory that also holds 1,000, 10,000 or 50,000 unrelated attachments, and reports the median of three runs. Raw results are in [`benchmarks/upload-cleanup.json`](benchmarks/upload-cleanup.json) (Bun 1.4.4, 2026-11-10).

| Unrelated entries | ext4 before | ext4 after | tmpfs before | tmpfs after |
|---|---|---|---|---|
| 1,000 | 401.0 ms (25 listings) | 21.9 ms (1 listing) | 14.6 ms | 5.2 ms |
| 10,000 | 510.2 ms | 30.5 ms | 101.2 ms | 6.8 ms |
| 50,000 | 804.9 ms | 54.8 ms | 354.3 ms | 17.7 ms |

On disk the per-key directory syncs dominated small directories, and the listings grew with the directory (about 98 ms of listings per batch at 10,000 entries and 354 ms at 50,000). On tmpfs, where syncs are cheap, the listings were almost the whole cost.

## Change

`LocalFileStore.revokeMany(keys)` fences every key first with the same loop as `revoke`, then lists the directory once, removes staging copies only for keys it fenced, and syncs the directory once. It returns the keys that failed with their errors. `revoke(key)` is now a one-key batch, so single-key callers keep the same behavior.

`UploadRecovery` still claims each cleanup record separately. It passes the claimed file records to `FileResolver.revokeLocalFiles` together and settles each record on its own result: a record is deleted only after its key is fenced, its staging copies are gone and the directory sync has completed; a failed key keeps its record and backs off. A failure of the shared listing or sync keeps every record of the batch. Spool directories are still fenced one by one, since they need no listing.

The publication and reclamation protocol is unchanged. Fences are installed before staging copies are removed and are never deleted. A writer that creates a staging copy after the batch listed the directory still cannot publish over the fence, and the startup sweep (`sweepFencedStaging`) removes such copies, as before. Staging copies of keys outside the batch, including writes in progress, are left alone.
