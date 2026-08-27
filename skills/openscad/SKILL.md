---
name: openscad
description: Create or edit parametric OpenSCAD models and deliver a print-ready STL with one inline exact render, plus SCAD source only when requested.
---

# OpenSCAD models

`openscad-build` is already installed in the thread's E2B toolbox. Work under `/home/user/workspace`. Do not probe for, install, or replace OpenSCAD, POV-Ray, CAD libraries, slicers, or printer profiles. Do not generate the mesh with Python or another CAD tool. Use `openscad-build`, not its internal `openscad` or `povray` commands.

## Build and inspect

Create or update `model.scad`. Use millimeters, expose important dimensions as named variables, and keep the model self-contained. Do not introduce BOSL2 or other libraries. For expensive curves, `$preview` may select a lower facet count while the final render uses the full value.

Normally create the SCAD file and run the fast internal preview in the same Bash call:

```bash
openscad-build preview model.scad
```

Call `inspect_workspace_images` once on `/model.preview.png`. Check the overall shape, holes, joins, clearances, orientation, and whether the result matches the request. Correct, rebuild, and inspect again only when the image reveals a problem. Preview geometry may use lower detail selected by `$preview`.

Use one automatically framed isometric view by default. Render extra temporary camera views only when the user asks for them or one view leaves the geometry ambiguous. Do not add separate view tools or deliver extra views unless requested.

Build the exact outputs after the preview is correct:

```bash
openscad-build final model.scad
```

This produces and validates a binary `model.stl` and `model.final.png` together. Do not run separate existence, format, dimension, size, or mesh-validation commands after a successful build. If the wrapper reports that the STL exceeds the delivery limit, reduce excessive facet counts and rebuild without silently changing the model's dimensions. Call `inspect_workspace_images` once on `/model.final.png`; fix and rebuild only if it exposes a problem.

## Delivery gate

Do not call `create_file` until the final build and final inspection have both succeeded. By default, queue exactly two deliverables, once each:

1. `/model.stl` with `delivery: "document"`
2. `/model.final.png` with `mime: "image/png"` and `delivery: "photo_only"`

Queue `/model.scad` with `delivery: "document"` only when the user explicitly asks for the SCAD or editable source. Do not generate or deliver 3MF. Never deliver `model.preview.png`, attach draft revisions, or send the final PNG as a document. If any build, inspection, or attachment step fails, report the failure instead of claiming the model is complete.
