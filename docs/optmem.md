# OptMem memory reference

The native port follows [VictorTaelin/OptMem commit 1fb164cf39028047781f72ac3bb1e5a691c1dcb0](https://github.com/VictorTaelin/OptMem/tree/1fb164cf39028047781f72ac3bb1e5a691c1dcb0). The upstream `memo` script and invariant suite define the memory behavior. All memory logic, including regex parsing and matching, runs as JavaScript compiled from TypeScript. No Python interpreter, Python package, or generated Python code is used.

## Bot commands

When memory is enabled, the main agent has a `memo` tool. Its argument is an array, for example `{"args":["note","Prefers metric measurements"]}`. Commands printed in tool output refer to this tool, not to sandbox Bash.

| Command | Behavior |
| --- | --- |
| `wake [part [T]]` | Reads the memory, with finer detail for recent records. Pages retain the same snapshot count `T`. |
| `note "text"` | Appends one dated record and offers the next pending compression. |
| `nap [lo-hi "summary"]` | Offers one compression or accepts its summary, then offers the next. |
| `recall regex` | Searches complete raw records, including IDs and dates, case-insensitively. Retains the newest matches that fit the output byte budget. |
| `zoom lo-hi` | Opens an aligned binary block into its two children. |
| `forget lo-hi` | Truncates summaries at that level and ancestor levels from the affected position onward. The raw log remains unchanged. |
| `config` | Displays the global settings. Assignments are rejected. |

The agent receives OptMem's upstream instruction block. Startup and compaction reminders request `wake` and completion of every printed page or compression. These are agent instructions, as upstream; there is no additional tool gate. Only the memory command itself refuses a wake when a required summary is missing. A final wake can report `You are awake.` and still offer pending compression work.

`memo` is unavailable inside codemode scripts. Helper sessions used for titles and image descriptions cannot call it. Main-provider fallback uses the same memory tool and store. Older saved sessions gain `memo` when reopened. The bot preserves full memory tool results during routine context pruning and requests another wake after compaction, including Codex checkpoint replay.

## Storage and settings

Each authenticated Telegram user owns one memory in the application database selected by `DB_URL`. SQLite and PostgreSQL use the same tables:

| Table | Contents |
| --- | --- |
| `optmem_stores` | The owner's next note ID and initialization marker. |
| `optmem_notes` | Immutable numbered notes with their original dates and UTF-8 bytes. |
| `optmem_summaries` | Dense prefixes of aligned binary summary blocks. |
| `users.memory_enabled` | The user's on/off preference, enabled by default. |

Memory spans a user's threads and forks, including facts recorded after an earlier fork point. Model arguments cannot choose another owner. Conversation and attachment searches retain their existing visibility rules. The bot does not automatically import chat history. The main agent chooses facts and writes summaries.

New notes use the user's configured timezone, defaulting to UTC, matching the date in their session context. Historical imports retain the dates supplied in the file.

Users can run `/memory` to see their status, `/memory off` to disable memory, or `/memory on` to enable it. This is their only memory setting. Disabling blocks memory commands, including writes from stale sessions, and removes the tool and activation instructions on the next turn. Saved notes remain in the database. Facts already present in conversation history remain there. Re-enabling requests another wake.

All tuning is global. Set only non-default values in `.env` and restart the bot. `memo config NAME=VALUE` cannot override them.

| Environment variable | Original default | Meaning |
| --- | --- | --- |
| `OPTMEM_WAKE_LINES` | 96 | Lines in wake's binary cover. A budget below the irreducible cover can be exceeded, as upstream. |
| `OPTMEM_ENTRY_CHARS` | 280 | Maximum note or summary length in UTF-8 bytes. Cannot exceed 280. |
| `OPTMEM_PART_CHARS` | 20000 | Byte budget per page and for retained recall matches. A single wake line is never split. |
| `OPTMEM_PART_LINES` | 500 | Maximum lines per wake page. |

All values must be positive integers. For example, to change only the wake budget:

```dotenv
OPTMEM_WAKE_LINES=128
```

Blocks of up to 16 records compress from raw notes. Larger blocks compress from their two child summaries. Pending blocks run smallest level first, then oldest first. The cover uses upstream's 60 alpha bisections and spends spare lines by splitting the rightmost remaining summary.

Mutations use database transactions. PostgreSQL locks the owner's preference row and store row; SQLite serializes writers and waits without blocking the event loop when another connection holds the lock. IDs are assigned inside the transaction. A failed batch rolls back entirely. Retrying an uncertain successful note can still append a duplicate, as upstream.

Back up the application database to preserve notes, summaries and preferences. Multiple PostgreSQL workers share these records through the database. Pi conversation sessions still use their existing filesystem storage and must be backed up separately.

New memories initialize directly in the database. Initialization is idempotent and preserves existing notes and summaries.

## Operator CLI

The CLI uses the same `DB_URL` and global environment settings as the bot. Supply an existing Telegram user ID. It supports all nine upstream commands, with `config` now read-only. `init` and `import` are operator-only commands. Imports accept host UTF-8 files with `YYYY-MM-DD text` per line and validate dates, order and byte limits before appending.

```sh
bun run memo --user 123456 init
bun run memo --user 123456 wake
bun run memo --user 123456 import ./dated-memories.txt
bun run memo --user 123456 config
```

After a build, use `bun dist/src/memory/optmem/cli.js --user 123456 wake`. The CLI respects the user's disabled preference. Printed continuations include the runtime path, script path and owner ID.

## Regex compatibility

Recall uses a native search-only implementation of Python's string-pattern grammar, with Unicode 16 data and Python 3.14 behavior. It supports Unicode classes and boundaries, inline and scoped flags, named and numbered captures, backreferences, lookarounds, conditionals, atomic groups, and possessive quantifiers. Case-insensitive backreferences use simple lowercase comparison; literal matching also handles Python's additional case equivalents. Regex syntax diagnostics identify errors, but their wording and positions are not a byte-for-byte copy of CPython's diagnostics.

Recall matches batches of up to 256 lines in a cancellable worker. Database access stays in the caller, so SQLite in-memory connections also work. An expensive regex cannot block other chat turns. No alternative search ranking, tokenization, embeddings, or hidden summaries are introduced.

## Design and verification

The host library and a process-per-command design were compared. The library keeps one command implementation shared by the tool and CLI. A worker is used only for recall, where regex execution needs independent cancellation. The compaction reminder is preserved in Codex replay. Database storage, global environment settings and the user on/off preference are application-specific changes to the original file-based system. The memory selection and compression algorithms are unchanged.

`src/memory/optmem/index.ts` owns command dispatch and output; `databaseStore.ts` owns transactional storage; `records.ts` preserves upstream byte limits and text handling; `blocks.ts` owns the cover; `regex.ts` owns search semantics. `userMemory.ts` binds authenticated owners. `ai/tools/memo.ts` and `pi/optmem.ts` handle tool transport and session activation.

Verification uses native tests ported from upstream scenarios and literal expected outputs and bytes. It covers a 2,000-record life, raw and summarized merges, snapshot paging, forget and rebuild, corruption and torn writes, concurrent processes, suspended and killed lock holders, Unicode regex cases, and CLI continuation commands. The upstream-format file implementation and its native lock binding are test-only dependencies. Database tests compare command transcripts with that reference and cover isolation, initialization, rollback, concurrent writers and disabled preferences on SQLite and PostgreSQL. Set `TEST_POSTGRES_URL` to run the PostgreSQL cases in isolated temporary schemas. Pi integration tests inspect provider requests for tool availability, toggling, restart, compaction and fallback. Tests do not execute Python or claim exhaustive equivalence for every possible Python regex.

```sh
bun run typecheck
bun run test
bun run build
```
