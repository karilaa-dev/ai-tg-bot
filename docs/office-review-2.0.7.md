# Office review fixes, 2.0.7

This release addresses the seven distinct findings on PR #40. The application version advances again because the previously published E2B `v2.0.6` image is immutable.

- Spreadsheet formulas may return an empty cached string. Calc recalculation still runs on a temporary copy; actual spreadsheet error cells still fail validation.
- Package checks resolve internal relationship targets consistently, including the root document relationship. LibreOffice rejects some equivalent `./` paths, so conversion uses a private copy with only those relationship URIs normalized. Every other package part and the original attachment bytes remain unchanged. Approval stays bound to the original content hash, and the render check records how many relationship parts were normalized.
- External OOXML resources, including linked media, templates, and workbooks, block validation before conversion. HTTP, HTTPS, and email hyperlinks remain available only in recognized hyperlink elements. Declaring an image relationship to be a hyperlink does not bypass the check. This is an OOXML relationship policy, not general sandbox network isolation.
- Approval records retain the validated Office format. Outgoing preparation and final queue verification reject contradictory extensions and MIME types, including Office bytes disguised as PDF. Renaming a file while retaining its correct format is supported.
- Failed preview cleanup retains its paths for a later retry. Successful deletion removes only the paths from that attempt.
- Sandbox upgrades upload into unique staging directories. The installer verifies a path-independent content hash, replaces the complete active bundle, and installs under one remote lock. Removed files cannot survive the replacement. Failed uploads preserve the active bundle, and reconnects verify the installed revision.
- Current version examples and assertions use `2.0.7`. Historical release reports retain their original versions.

## Verification

Local typecheck, build, and 470 tests passed. Two PostgreSQL integration tests were skipped because `TEST_POSTGRES_URL` was not configured.

The local Office contract passed on LibreOffice 26.2.5.2. It covers all four authoring backends, formula results including blank values and errors, actual PDF/page rendering, normalized relationships in DOCX/PPTX/XLSX, unchanged source bytes and untouched package parts, blocked external relationships, and a real HTTP endpoint that receives no requests when rendering a normal hyperlink.

The live upgrade from `ai-tg-bot-tools:v2.0.6` passed on LibreOffice 7.4.7.2, using the existing 2 vCPU and 2048 MiB allocation. It preserved the sandbox identity, workspace, and saved sources, removed an obsolete bundle file, and verified that two staged installers waited on the same remote lock. Pause/resume passed without another upgrade. The new-image build and release smoke test are in progress.
