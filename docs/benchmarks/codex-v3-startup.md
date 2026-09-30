# Codex v3 prompt and startup measurements

Measured on 2026-09-30 with bundled Codex 0.159.2. Production data were inspected read-only; controlled checks used isolated homes, databases, and sandboxes. Protocol captures use synthetic requests and a localhost Responses provider without paid inference.

## Observed cold and warm turns

| Turn | Provider input tokens | Cached tokens | Output tokens | Reported response interval |
| --- | ---: | ---: | ---: | ---: |
| First simple question | 18,309 | 0 | 84 | 7.72 s |
| Next question in the same chat | 18,490 | 18,176 | 5 | 2.178 s |

The second turn reused 98.3% of its input. Telegram delivery took about 0.5 s in each case. These are two observations, not a latency benchmark or a Pi comparison. The response interval in the original logs included bot processing around the model cycle; the updated metrics separate the harness interval, first text, first draft, and delivery.

`responseCycleMs` sums response completion intervals and includes tool execution and executor preparation. It is not pure inference time; do not add tool durations to it. `firstModelTextMs` and `firstThinkingMs` track model text deltas, `firstDraftMs` tracks acknowledgement of a Telegram preview, and the existing `firstTextMs` tracks the confirmed final send. The final answer now goes directly to a confirmed message, eliminating one serial draft HTTP call. Provisional streaming remains available through Telegram's [draft API](https://core.telegram.org/bots/api#sendrichmessagedraft).

The native harness has a substantial initial prompt even for a short question. A warm thread can reuse most of that prefix. Codex supplies a per-thread `prompt_cache_key`; these observations establish reuse within a thread, not reuse between new chats or ephemeral helper threads.

## Controlled request attribution

The real bundled app-server sent the following synthetic main-chat requests to the local Responses fixture. Token counts below use `o200k_base` from tiktoken 1.0.22. They approximate text size and are **not provider-reported or billable token counts**. JSON escaping, message framing, generated IDs, account capabilities, and server tokenization affect totals.

| Component | Approximate tokens | Effect of disabling native skill instructions |
| --- | ---: | --- |
| Native core instructions | 4,212 | Unchanged |
| Serialized native tool declarations | 8,499 | Byte-identical |
| Bot behavior and its six workflow descriptions | 1,104 | Unchanged |
| Native private-home skill catalog | 466 | Removed |
| Complete serialized baseline request | About 17,000 | About 16,500 after the override |

The native declarations include about 2,504 tokens of `web__run` documentation and 1,200 tokens for collaboration. The initially declared bot functions account for about 570 text tokens. Other bot functions remain discoverable through deferred tools; their full schemas are not all inserted into the first request.

The anonymous fixture has no authenticated account apps or native image-generation tool. It does expose native shell, patch, image inspection, web search, and bot tools. Before and after the change, actual code-mode probes confirm the same command, patch, view-image, and `read_skill` functions. Both turns leave the E2B executor unstarted. Separate authenticated smoke checks cover native image generation.

The production native skill catalog was larger than this private fixture: 11,083 characters, approximately 2,724 tokens. It advertised host skill paths which the remote shell could not read. Setting `skills.include_instructions = false` stops automatic catalog injection on conversation start, resume, fork, and helper start. The bot's own workflow descriptions and `read_skill` implementation remain available. This setting changes skill prompt injection, not native tool availability.

Existing valid threads retain the catalog already recorded in their history. A real restart/resume check preserved the native thread ID and found one historical catalog, followed by native updates saying host and selected-environment skills are no longer listed automatically. `thread/resume` did not replace the previously persisted bot developer instructions with the newly rendered prompt. The bot therefore prepends a small workspace and discovery reminder to the native current-turn input, so existing chats receive the correction while retaining their history and cache key. OpenRouter input remains unchanged.

## OpenSCAD context growth

The nine-cycle OpenSCAD turn grew from 18,375 to 27,077 input tokens after its first tool batch. The skill read itself took about 2 ms.

| First tool output | Characters | Approximate text tokens |
| --- | ---: | ---: |
| Pinned OpenSCAD guide | 3,341 | 705 |
| Broad `ALL_TOOLS` lookup | 36,000 | 7,781 |

The lookup searched generic terms including `file` and `command` in tool names and descriptions, matching 143 tools. That catalog output and the guide explain nearly all of the 8,702-token increase. The guide is already compact and remains unchanged, including its pinned hash and sandbox assets.

The bot prompt now instructs discovery to filter by an exact tool name or narrow task term, print at most five matching names, and inspect only their descriptions. All tools remain available. Discovery guidance adds approximately 27 tokens, and the host-path reminder about 20 more. The current native turn repeats this small reminder so old threads receive it too. `read_skill` also states that it returns the complete guide, so another shell read is unnecessary. Prompt instructions reduce the chance of a catalog dump; they do not enforce a runtime output limit.

Cycle 5 had an isolated cache miss: 28,157 input tokens and zero cached tokens. It called the first `view_image`; that image entered the following request, which reused 28,032 tokens. The rollout contains no intervening developer-message rewrite or compaction. It does not contain complete request declarations or backend cache routing, so the cause of this miss cannot be established from these records.

## Controlled E2B preparation

A separate benchmark used real E2B, a scratch database and deployment, synthetic local model responses, and two disposable sandboxes. Both sandboxes were cleaned up. The checks exercised the real native executor connection, command lifecycle, sandbox resume, and recreation. They performed no paid model inference.

| Executor state | Before preparation | After preparation | Preparation reduction |
| --- | ---: | ---: | ---: |
| Cold sandbox | 5,683 ms | 4,037 ms | 29% |
| Recreated sandbox | 5,795 ms | 3,774 ms | 35% |
| Resumed sandbox | 624 ms | 443 ms | 29% |

Warm complete-turn medians were 300 ms before and 293.5 ms after, with eight samples each and overlapping ranges. This does not establish a warm-turn improvement. The change removes repeated version checks, overlaps validated preparation, and limits permission sealing to the required files and their parent directories. The existing wrapper uses the verified native executable path.

Plain questions and local image operations created no sandbox, including while a previous sandbox was paused. These preparation measurements do not predict a proportional reduction of the 107-second OpenSCAD turn, which also included model cycles, command execution, image inspection, and delivery. Network and CPU variation remain material.

Native command durations in that OpenSCAD rollout were about 9.515 s for preview rendering and 7.140 s for final rendering, with other commands adding about 0.084 s. The approximately 16.74 s command total sits inside the 107.6 s turn. The two immediate failures were a missing host `unslop` skill path with exit code 1 and unsupported `openscad-build --help` usage with exit code 2, rather than executor transport failures. Nine model round trips likely account for much of the remaining time, but the recorded response intervals include tools and cannot establish pure inference time.

The later sandbox policy change removes automatic Office, PDF, and executor upgrades entirely. Existing tools stay in place; blocked tasks ask the user to recreate the chat. Preparation no longer includes the global Office/PDF preflight. The timings above describe the preceding measured implementation.

## Reproduction

Run the real-protocol checks without credentials or external inference:

```sh
bun run test -- test/codex/protocol.test.ts -t 'native skill catalog isolation|native prompt measurements'
```

Reproduce executor timings with configured E2B credentials and scratch resources:

```sh
CODEX_SMOKE_BENCHMARK=1 bun run live:codex-executor-check
```

The executor check reports structured preparation stages and warm samples, verifies a native command exiting with code 7, protected assets and credential handling, attachment recovery, and no sandbox wake for plain questions. Preparation stages overlap and must not be summed. Repeated final runs observed roughly 4.17–4.40 s cold complete turns and 3.79–3.94 s recreated turns versus approximately 5.97 s before; warm turns remained around 0.3 s.

Optionally capture the synthetic initial requests in a private file for an independent tokenizer:

```sh
CODEX_PROTOCOL_REQUEST_CAPTURE=/tmp/codex-prompt-fixture.json \
  bun run test -- test/codex/protocol.test.ts -t 'measures the complete native chat prompt'
```

The capture contains `baseline` and `optimized` request objects, uses mode 0600, and contains only fixture prompts. It does not read live credentials or copy production conversation text. Compare `input` text and `additional_tools` declarations separately rather than treating the entire serialized request as provider usage.

The regression also installs a synthetic host-only skill, confirms that the default native catalog advertises it, disables the catalog, discovers the bot's deferred `read_skill`, and reads the unchanged OpenSCAD guide without starting E2B.
