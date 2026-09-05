# Approved Pi skills

The bot advertises reviewed, checksum-verified local skills:

- `docx-cli` for Word creation and targeted edits
- `pptxgenjs` for new editable PowerPoint decks
- `pptx-edit` for edits to existing presentations
- `xlsx` for ordinary Excel workbooks
- `sandbox-files` for attachment routing and PDF inspection
- `openscad` for SCAD modeling, preview inspection, binary STL export, and exact renders

The docx-cli skill is adapted from `kklimuk/docx-cli` release 0.25.0, commit `e528738ed22d1294be7938d7614525b4a585fa56`. Installation and updating are owned by the sandbox bundle. The other Office skills and PptxGenJS examples are maintained here; no MiniMax workflow is imported. The original Word skill license is included beside it, and binary notices are bundled in `e2b-template/assets/office/licenses`.

`src/pi/officeSkills.ts` stores approved skill hashes and validates them at startup. The read tool only opens files under approved skill directories. The Office tools and locked dependencies live in `e2b-template/assets/office`; no skill installs packages during a user task.

Office skills share enforced actual-file validation and explicit visual review through `validate_office_file` and `render_office_preview`. Changes invalidate review by content hash. Files with incomplete or failed checks stay in the workspace.

Review upstream changes before updating pins, hashes, tests, or license material.
