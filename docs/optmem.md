# OptMem memory reference

The native port follows [VictorTaelin/OptMem commit 1fb164cf39028047781f72ac3bb1e5a691c1dcb0](https://github.com/VictorTaelin/OptMem/tree/1fb164cf39028047781f72ac3bb1e5a691c1dcb0). The upstream `memo` script and invariant suite define the memory behavior. All memory logic, including regex parsing and matching, runs as JavaScript compiled from TypeScript. No Python interpreter, Python package, or generated Python code is used.

## Bot commands

The main agent has an always-active `memo` tool. Its argument is an array, for example `{"args":["note","Prefers metric measurements"]}`. Commands printed in tool output refer to this tool, not to sandbox Bash.

| Command | Behavior |
| --- | --- |
| `wake [part [T]]` | Reads the memory, with finer detail for recent records. Pages retain the same snapshot count `T`. |
| `note "text"` | Appends one dated record and offers the next pending compression. |
| `nap [lo-hi "summary"]` | Offers one compression or accepts its summary, then offers the next. |
| `recall regex` | Searches complete raw records, including IDs and dates, case-insensitively. Retains the newest matches that fit the output byte budget. |
| `zoom lo-hi` | Opens an aligned binary block into its two children. |
| `forget lo-hi` | Truncates summaries at that level and ancestor levels from the affected position onward. The raw log remains unchanged. |
| `config [NAME=VALUE ...]` | Reads or changes this store's sizes. An empty value restores the default. |

The agent receives OptMem's upstream instruction block. Startup and compaction reminders request `wake` and completion of every printed page or compression. These are agent instructions, as upstream; there is no additional tool gate. Only the memory command itself refuses a wake when a required summary is missing. A final wake can report `You are awake.` and still offer pending compression work.

`memo` is unavailable inside codemode scripts. Helper sessions used for titles and image descriptions cannot call it. Main-provider fallback uses the same memory tool and store. Older saved sessions gain `memo` when reopened. The bot preserves full memory tool results during routine context pruning and requests another wake after compaction, including Codex checkpoint replay.

## Stores and configuration

Each authenticated Telegram user owns one store. Its default path is `<PI_CODING_AGENT_DIR>/memory/<tg_id>`, normally `./data/pi/memory/<tg_id>`. `OPTMEM_DIR` overrides the parent. Model arguments cannot select a directory or another user.

Memory intentionally spans that user's threads and forks, including facts recorded after an earlier fork point. Conversation and attachment searches retain their existing thread visibility rules. The bot does not automatically import chat history or extract notes from every message. The main agent decides what to retain and supplies every requested summary.

The bot initializes a user's store when constructing their main runtime. Individual tools never create a missing store. The standalone CLI requires explicit `init`. Initialization is idempotent and preserves existing records, summaries, and configured values.

| File | Format |
| --- | --- |
| `LOG.txt` | 320-byte UTF-8 records, `#id YYYY-MM-DD text`, padded with spaces and terminated by LF. Position determines ID. |
| `TREE/<size>` | 288-byte summary records. Each file is a dense prefix of aligned blocks of that size. |
| `config` | Per-store overrides with upstream's commented defaults. |
| `.lock` | Kernel advisory lock shared by mutations. |

| Setting | Default | Meaning |
| --- | --- | --- |
| `WAKE_LINES` | 96 | Reading budget for wake's binary cover. A budget smaller than the irreducible binary cover can be exceeded, as upstream. |
| `ENTRY_CHARS` | 280 | Maximum note or summary length in UTF-8 bytes, not characters. Cannot exceed 280. |
| `PART_CHARS` | 20000 | Byte budget for each page and recall's retained matches. A single wake line is never split. |
| `PART_LINES` | 500 | Maximum lines per wake page. |

Blocks of up to 16 records compress from the raw log. Larger blocks compress from their two child summaries. Pending blocks run smallest level first, then oldest first. The cover uses upstream's 60 alpha bisections and spends spare lines by splitting the rightmost remaining summary.

Native file locking uses the OS through `@lickle/lock`, with no lock expiry. A suspended process retains ownership; process termination releases it. IDs are assigned inside the lock. Appends repair incomplete trailing records, then flush and synchronize before success. Interrupted imports may leave complete appended records, and interrupted forgets may leave partially truncated tree levels, as upstream. Retrying an uncertain note can append a duplicate.

Preserve the memory volume across deployments. Workers serving the same users need the same memory filesystem, alongside the shared Pi session files. PostgreSQL does not replicate these files. Back up the log, tree, and config together while writers are stopped. Never manually rewrite the log or delete raw records to repair a summary; `forget` and `nap` rebuild the tree.

## Operator CLI

The CLI supports all nine upstream commands, including `init` and `import`. Those two commands are not exposed to the model. Imports accept a host UTF-8 file with `YYYY-MM-DD text` per line and validate dates, order, and byte limits before appending.

```sh
MEMORY_DIR=./data/pi/memory/123456 bun run memo init
MEMORY_DIR=./data/pi/memory/123456 bun run memo wake
MEMORY_DIR=./data/pi/memory/123456 bun run memo import ./dated-memories.txt
MEMORY_DIR=./data/pi/memory/123456 bun run memo config WAKE_LINES=128
```

After a build, the entrypoint is `bun dist/src/memory/optmem/cli.js`. Without `MEMORY_DIR`, the standalone CLI uses `~/.optmem/memory`, as upstream. This CLI environment variable does not override the bot's tenant binding. Printed CLI commands include the absolute runtime and script paths, so they work without a `memo` executable on `PATH`.

Existing upstream stores use the same durable record format. They can be placed in a user's directory while writers are stopped. The bot's only new dependency on native code is the kernel lock binding, which provides prebuilt packages for Linux x64 with glibc, macOS x64 and arm64, and Windows x64. The application and CLI use Bun; another deployment target needs a compatible lock binding.

## Regex compatibility

Recall uses a native search-only implementation of Python's string-pattern grammar, with Unicode 16 data and Python 3.14 behavior. It supports Unicode classes and boundaries, inline and scoped flags, named and numbered captures, backreferences, lookarounds, conditionals, atomic groups, and possessive quantifiers. Case-insensitive backreferences use simple lowercase comparison; literal matching also handles Python's additional case equivalents. Regex syntax diagnostics identify errors, but their wording and positions are not a byte-for-byte copy of CPython's diagnostics.

Recall runs in a cancellable worker when called by the bot. An expensive regex cannot block other chat turns. No alternative search ranking, tokenization, embeddings, or hidden summaries are introduced.

## Design and verification

The host library and a process-per-command design were compared. The library keeps one command implementation shared by the tool and CLI. A worker is used only for recall, where regex execution needs independent cancellation. The design adopts explicit preservation of the compaction reminder in Codex replay. Lease locks and hard tool gates were rejected because they change upstream behavior.

`src/memory/optmem/index.ts` owns command dispatch and output; `store.ts` owns durable records and locking; `blocks.ts` owns the cover; `regex.ts` owns search semantics. `userMemory.ts` binds authenticated owners. `ai/tools/memo.ts` and `pi/optmem.ts` handle tool transport and session activation.

Verification uses native tests ported from upstream scenarios and literal expected outputs and bytes. It covers a 2,000-record life, raw and summarized merges, snapshot paging, forget and rebuild, corruption and torn writes, concurrent processes, suspended and killed lock holders, Unicode regex cases, and CLI continuation commands. Pi integration tests inspect actual provider requests for tool availability, restart, compaction, and fallback. Tests do not execute Python or claim exhaustive equivalence for every possible Python regex.

```sh
bun run typecheck
bun run test
bun run build
```
