---
name: openscad
description: Create or edit parametric OpenSCAD models and deliver the editable SCAD, STL, 3MF, and an inline rendered photo.
---

# OpenSCAD models

OpenSCAD and `openscad-build` are already installed in the thread's E2B toolbox. Work under `/home/user/workspace`. Do not install OpenSCAD, CAD libraries, slicers, or printer profiles.

## Build and inspect

Create or update `model.scad`. Use millimeters, expose important dimensions as named variables, and keep the model self-contained. Do not introduce BOSL2 or other libraries. For expensive curves, `$preview` may select a lower facet count while the final render uses the full value.

Generate the fast internal preview:

```bash
openscad-build preview model.scad
```

Call `inspect_workspace_images` on `/model.preview.png`. Check the overall shape, holes, joins, clearances, orientation, and whether the result matches the request. Correct `model.scad`, rebuild, and inspect again when necessary. Preview geometry is approximate.

Use one automatically framed isometric view by default. Render extra temporary camera views only when the user asks for them or one view leaves the geometry ambiguous. Do not add separate view tools or deliver extra views unless requested.

Build the exact outputs after the preview is correct:

```bash
openscad-build final model.scad
```

This must produce `model.stl`, `model.3mf`, and `model.final.png`. Call `inspect_workspace_images` on `/model.final.png` because it shows the exact rendered geometry. Fix and rebuild if it exposes a problem.

## Delivery gate

Every completed model requires four `create_file` calls:

1. `/model.scad` with `delivery: "document"`
2. `/model.stl` with `delivery: "document"`
3. `/model.3mf` with `delivery: "document"`
4. `/model.final.png` with `mime: "image/png"` and `delivery: "photo_only"`

Never deliver `model.preview.png`. Never send the final PNG as a document. If any build, inspection, or attachment step fails, report the failure instead of claiming the model is complete.
