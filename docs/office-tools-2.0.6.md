# Office tools and reusable images, 2.0.6

OfficeCLI has been replaced by docx-cli 0.25.0, PptxGenJS 4.0.1, python-pptx 1.0.2, and openpyxl 3.1.5. The Word skill is adapted from release commit `e528738ed22d1294be7938d7614525b4a585fa56`. The other Office skills and deck helpers are maintained here. Dependency locks, download hashes, and upstream licenses are included in the sandbox bundle.

Saved Office files are checked and converted by LibreOffice, then rendered to model-only page images with Poppler. Delivery requires all applicable checks and explicit visual approval for every page of the exact content hash. Rendering alone grants no approval. Final preparation checks queued files again for edits or withdrawn approval. Failed drafts can be retained with `finish_response.retain_drafts` while explaining the blocker. Temporary review artifacts are removed after the turn; source files remain in the workspace.

`generate_image` returns a saved original's absolute workspace path, format, dimensions, provider metadata, and an image preview. It neither attaches the asset nor ends inference. References may combine current-thread file IDs and workspace paths, up to five. Normal attachment preparation handles deliberate delivery and persistence.

## Verification

On September 5, 2026, typecheck, 459 tests, and the build passed. Two PostgreSQL integration tests were skipped because `TEST_POSTGRES_URL` was not configured. All four skill files passed the skill validator and approved-registry integrity checks.

`npm run e2b:release` built and validated `ai-tg-bot-tools:v2.0.6` and passed the full live E2B smoke test. Build ID: `fa380a7c-1cf0-4696-af98-abd0177c9d07`.

`E2B_UPGRADE_FROM=ai-tg-bot-tools:v2.0.5 npm run live:e2b-check` passed. It reconnected an existing sandbox, upgraded under the installer lock, retained workspace and saved-source bytes, removed OfficeCLI after replacement checks, and verified pause/resume behavior.

`npm run live:pi-image-check` passed with real model and image-provider calls. The image-only case used two tool calls and prepared only the generated image. The deck case used seven tool calls, received the generated image as model vision input, embedded byte-identical original artwork, recorded passing visual reviews for both slides, and prepared only the PPTX. Disposable sessions queued the files through `finish_response`; the smoke test sent no Telegram messages.

The Office contract exercises Word formatting, tables, targeted replacements, tracked changes, and comments; new deck text, tables, charts, and artwork; existing-deck preservation; spreadsheet formulas and print layout; actual-file PDF/page conversion; malformed XML, corrupt ZIPs, missing parts and relationships, formula errors, and unavailable rendering. Host tests cover partial reviews, unseen pages, stale hashes, all attachment entry points, post-queue changes, multiple image assets, editing a generated image, fallback, cancellation, failed writes, and cross-thread reference rejection.

PptxGenJS 4.0.1 emits unused slide-master content-type declarations. The tested `save` helper removes those declarations without changing existing package parts. Package validation remains strict. Existing-deck preservation compares canonical XML and exact binary media bytes, allowing harmless XML serialization differences.

## Measured resources

The E2B image remains at 2 vCPU and 2048 MiB RAM. Its renderer is LibreOffice 7.4.7.2. The live release contract measured:

| Fixture | Pages | Validation and conversion | Peak child-process RSS |
| --- | ---: | ---: | ---: |
| Word | 1 | 5.630 s | 209.3 MiB |
| New deck | 2 | 1.771 s | 210.0 MiB |
| Edited deck | 2 | 1.321 s | 210.0 MiB |
| Workbook | 1 | 2.369 s | 210.3 MiB |

These are small functional fixtures, not load-test limits or a whole-sandbox peak-memory measurement. The contract rejects runs over 120 seconds or 1.5 GiB child-process RSS. Conversions are serialized. Static LibreOffice review does not certify Microsoft Office rendering, animations, external data connections, or unsupported editing features.

APT reported 331 MB of additional packages in E2B. Measured installed directories were 74,991 KiB for `/opt/office`, 237,980 KiB for `/usr/lib/libreoffice`, 12,640 KiB for `/usr/share/libreoffice`, and 8,176 KiB for fonts. These directory measurements overlap the package estimate and exclude dependencies stored elsewhere; they must not be added to that estimate.

Machine-readable results are in [the benchmark record](benchmarks/office-tools-2.0.6.json).

## Presentation quality follow-up

The reported Tokyo presentation contained seven slides and no embedded images. Five consecutive body slides repeated a three-card composition. The new authoring stack and structural approval had not corrected this design weakness. The shared delivery layer also appended a technical validation caption that the user did not want.

Delivery now preserves the requested caption, including no caption. Validation still gates every Office attachment internally. `web_search` exposes optional image discovery through the existing search provider. The revised PptxGenJS skill acquires relevant imagery for visual subjects, considers a subject-specific art direction, uses varied compositions, preserves source credits, and reviews the rendered result for design quality as well as defects. Generated artwork remains available for concepts and illustrations; factual photographs use retrieved sources.

Two live runs used the original request, `сделай презентацию на тему "Город будущего" Токио`, with no added tool, imagery, or validation instructions. Both produced seven-slide presentations, independently retrieved and inspected image assets, approved all rendered slides, and queued only the PPTX with no caption. The first used three photographs; review found cramped title spacing and a generic palette, prompting a second skill revision. The final run used a Tokyo photograph and a sourced Tokyo eSG concept illustration, with a light palette, a route diagram, large numerical emphasis, and varied text layouts. The illustration was explicitly labeled as conceptual. The rendered slides were inspected independently after the bot's approval.

This is a regression check for the reported request, not evidence that arbitrary presentations match a curated showcase. The image-area threshold detects the original absence of substantial imagery; it does not grade aesthetics. The live driver saves the actual PPTX, PDF, slide images, and trace for further comparison. Results and review limitations are recorded in [the presentation benchmark](benchmarks/presentation-quality-2.0.6.json).

After this follow-up, typecheck, 462 tests, and build passed; the same two PostgreSQL tests were skipped. The skill validator and registry integrity checks passed. These changes affect application code, skills, and verification scripts. No sandbox assets changed after the published `v2.0.6` image, so testing the new behavior requires deploying the updated bot application with that existing image.
