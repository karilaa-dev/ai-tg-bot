---
name: officecli-pptx
description: "Use for any task that reads, creates, or edits a PPTX file. This includes slide decks, pitches, presentations, templates, layouts, notes, comments, charts, animations, merging, splitting, and any request that names a .pptx file."
---

# OfficeCLI PPTX skill

## Scope

Use OfficeCLI for every PPTX task. The bot already provides a pinned binary in E2B. Do not install or update it.

This skill covers decisions, workflow, and delivery checks. The installed command reference defines the accepted properties and enum values:

```bash
officecli help pptx
officecli help pptx <element>
officecli help pptx <verb> <element>
officecli help pptx <element> --json
```

Read help before guessing an animation preset, connector type, property alias, or other uncertain value. The installed help output wins when it differs from this file.

## Shell rules

Set the target once:

```bash
FILE="deck.pptx"
```

Quote every path that contains brackets:

```bash
officecli get "$FILE" "/slide[1]/shape[2]"
```

Single-quote text with a dollar sign:

```bash
officecli add "$FILE" "/slide[2]" --type shape --prop text='$15M'
```

OfficeCLI interprets `\n` as a paragraph break and `\t` as a tab in `text=`. Use `\\n` or `\\t` for a literal backslash sequence.

An unquoted batch heredoc expands shell variables such as `$FILE` and `$SLIDE`. It also expands currency values. Escape a literal dollar sign as `\$`, or use a single-quoted heredoc when the body needs no shell-variable expansion.

Check `view text` after writing shell-sensitive values.

OfficeCLI mutates the file on each successful call. Work slide by slide, check each exit status, and inspect structural additions before adding dependent elements. Open the file before editing and save it before another program or the delivery layer reads it:

```bash
officecli open "$FILE"
officecli save "$FILE"
```

Use `officecli close "$FILE"` when no more edits are expected. Save and close operations can fail, so check their output.

## Design baseline

Match an existing theme, master, and template before applying any default below.

- Give each slide one main point. Split unrelated arguments instead of shrinking them into one frame.
- Make the title the first readable element. A practical starting point is 36 to 44 pt for titles, 20 to 24 pt for section text, and 18 to 22 pt for body text.
- Keep body copy left aligned unless the layout has a clear reason not to.
- Use one heading font, one body font, and a small, consistent palette.
- Put content at least 1.27 cm from each slide edge. Keep repeated gaps consistent and leave enough empty space for the layout to breathe.
- Use charts, diagrams, images, or purposeful shapes when they explain the point. Do not add decoration just to satisfy a visual quota.
- Add speaker notes when the requested deliverable needs a spoken script. Do not invent notes for a deck that will only be read.
- Give every meaningful picture alt text.
- Keep every slide understandable as a static frame. Animations and zoom links do not render consistently in every viewer.
- Keep placeholder text out of the delivered file.

Avoid common generated-deck habits: decorative title underlines, repeated rounded cards with a colored stripe, emoji used as generic icons, manufactured one-word drama, and filler statistics with no source.

## Plan before building

Write the ordered title list first. The titles should tell a coherent story without the body copy. Pick one title style, such as topic phrases or complete claims, and use it consistently.

Choose a grid, fonts, palette, and one recurring visual motif before creating slides. A motif can be a section-number treatment, image frame, side band, or another element that has a clear role. Do not force it onto a slide where it competes with the content.

For a custom design, add slides in audience order and use `layout=blank`. Linear append is easier to audit than repeated index insertion.

## Core workflow

1. Create or open the file.
2. Inspect an existing deck before changing it.
3. Write the title sequence and choose the visual system.
4. Build each slide in display order.
5. Add background elements first and titles last because later shapes sit higher in z-order.
6. Name important shapes when creating them.
7. Save and run structural, textual, and visual checks.
8. Fix defects and repeat the checks.

```bash
officecli create "$FILE"
officecli open "$FILE"
officecli view "$FILE" outline
officecli view "$FILE" issues
officecli validate "$FILE"
```

For an existing deck, omit `create`.

## Inspect a deck

```bash
officecli view "$FILE" outline
officecli view "$FILE" annotated
officecli view "$FILE" text --start 1 --end 5
officecli view "$FILE" issues
officecli view "$FILE" stats

officecli get "$FILE" "/slide[1]" --depth 1
officecli get "$FILE" "/slide[1]/shape[@name=Title]"
officecli get "$FILE" "/slide[1]/table[1]" --depth 3
```

Semantic paths use one-based indexes. `--index` uses zero-based insertion positions. Prefer `@name=` selectors for important shapes because names survive most reorderings.

Queries provide cross-deck checks:

```bash
officecli query "$FILE" 'shape:contains("Revenue")'
officecli query "$FILE" 'picture:no-alt'
officecli query "$FILE" 'shape[fill=1E2761]'
officecli query "$FILE" 'shape[width>=10cm]'
```

With `--json`, results are in `.data.results[]`. Shape names are in `.name`; fill and text colors are under `.format`.

A blank-layout title is a normal shape, not a title placeholder. `view outline` may call that slide untitled. This is expected unless the deck needs placeholder-based accessibility or template behavior.

## Create and edit slides

### Slides and backgrounds

```bash
officecli add "$FILE" / --type slide --prop layout=blank --prop background=FFFFFF
officecli add "$FILE" / --type slide --prop layout=blank \
  --prop "background=1E2761-CADCFC-180"
officecli add "$FILE" / --type slide --prop layout=blank \
  --prop background=image:/home/user/workspace/hero.jpg
```

For image backgrounds, inspect the image first. Cover the region without stretching it. Crop photos when needed, but fit screenshots, diagrams, and logos so no content is lost.

### Shapes and text

```bash
officecli add "$FILE" "/slide[2]" --type shape \
  --prop name=Title --prop text="Revenue grew 18% year over year" \
  --prop x=1.5cm --prop y=1.2cm --prop width=30cm --prop height=2.2cm \
  --prop font=Georgia --prop size=38 --prop bold=true \
  --prop color=1E2761 --prop fill=none
```

Positioning is explicit. Calculate repeated x positions and widths from the slide size, margins, and gap. Do not hand-tune each card independently.

For mixed formatting within a paragraph, add a run:

```bash
officecli add "$FILE" \
  "/slide[2]/shape[@name=Body]/paragraph[1]" \
  --type run --prop text=" Supporting detail" \
  --prop size=18 --prop italic=true --prop color=6B7B8D
```

Grow a text box or shorten the copy when it clips. Never solve a crowded slide by shrinking descriptive text below a readable size.

### Charts

Choose the chart from the data:

| Data | Good default | Avoid |
| --- | --- | --- |
| Category comparison | Column, or horizontal bar for many categories | Line without a time axis |
| Time series with a few series | Line | Pie |
| Part of whole with two to five values | Pie or doughnut | Many small slices |
| Correlation or distribution | Scatter | Line that implies order |
| One KPI | Large text | Gauge |

Split a chart when more than three series and eight categories make it hard to read.

```bash
officecli add "$FILE" "/slide[3]" --type chart \
  --prop chartType=column \
  --prop series1.name=Revenue --prop series1.values="42,45,48" \
  --prop series1.color=1E2761 \
  --prop series2.name=Plan --prop series2.values="40,42,45" \
  --prop series2.color=CADCFC \
  --prop categories="Q1,Q2,Q3" \
  --prop x=2cm --prop y=4cm --prop width=20cm --prop height=10cm
```

Use `officecli help pptx add chart` for axis, legend, and series properties. Remove chart-title placeholders such as `TBD`, `()`, or `[]`. Verify chart colors in the target viewer because some viewers apply theme defaults.

### Pictures

```bash
officecli add "$FILE" "/slide[4]" --type picture \
  --prop src=hero.jpg \
  --prop x=1cm --prop y=1cm --prop width=32cm --prop height=18cm \
  --prop alt="Product screen with account summary"
```

Do not stretch a picture. Put text over a photo only when a card, solid scrim, or gradient protects its contrast. Give transparent logos and diagrams a deliberate contrasting background.

### Connectors and diagrams

Connect named shapes:

```bash
officecli add "$FILE" "/slide[5]" --type connector \
  --prop "from=/slide[5]/shape[@name=BoxA]" \
  --prop "to=/slide[5]/shape[@name=BoxB]" \
  --prop shape=elbow --prop color=333333 --prop tailEnd=triangle
```

Directional flows need arrowheads. Use named shapes and inspect the slide after adding each branch. A line that misses its target or crosses a label can still be schema-valid.

### Tables, groups, links, notes, and comments

- Add a table with `--type table --prop rows=N --prop cols=M`. Populate text before applying table-wide font settings.
- Placeholders exist only on layouts that define them. Address them as `placeholder[title]` or `placeholder[body]`.
- Address group children with paths such as `/slide[N]/group[@name=G]/shape[1]`.
- Add a slide jump with `link=slide[N]`; use `link=https://...` for an external URL.
- Add notes with `--type notes --prop text="..."`.
- Add reviewer comments beneath `/slide[N]` and remove them after resolution when the user wants a clean file.

```bash
officecli add "$FILE" "/slide[2]" --type comment \
  --prop author="AI assistant" --prop text="Confirm this figure." \
  --prop x=20cm --prop y=3cm
```

Use the author named by the user. Otherwise choose a neutral label rather than impersonating a person or vendor.

### Animations

Use animation only when it clarifies sequence or emphasis. Essential content must remain understandable when animation does not play.

```bash
officecli set "$FILE" \
  "/slide[2]/shape[@name=HeroCard]" \
  --prop animation=fade-entrance-400
officecli set "$FILE" \
  "/slide[2]/shape[@name=HeroCard]" \
  --prop animation=none
```

Read `officecli help pptx animation` for valid presets. Screenshots and HTML previews cannot verify runtime animation. State that limitation unless the file was opened in a compatible presentation viewer.

## Quick start

This two-slide example is a starting point, not a template to copy into every deck:

```bash
FILE="deck.pptx"
officecli create "$FILE"
officecli open "$FILE"

officecli add "$FILE" / --type slide --prop layout=blank --prop background=1E2761
officecli add "$FILE" "/slide[1]" --type shape \
  --prop name=CoverTitle --prop text="FY26 strategic review" \
  --prop x=2cm --prop y=6.5cm --prop width=29.87cm --prop height=3cm \
  --prop font=Georgia --prop size=44 --prop bold=true \
  --prop color=FFFFFF --prop align=center
officecli add "$FILE" "/slide[1]" --type shape \
  --prop text="Acme leadership | 20 August 2026" \
  --prop x=2cm --prop y=10.5cm --prop width=29.87cm --prop height=1.2cm \
  --prop font=Calibri --prop size=18 --prop color=CADCFC --prop align=center

officecli add "$FILE" / --type slide --prop layout=blank --prop background=FFFFFF
officecli add "$FILE" "/slide[2]" --type shape \
  --prop name=Title --prop text="Revenue grew 18% year over year" \
  --prop x=1.5cm --prop y=1.2cm --prop width=30cm --prop height=2.2cm \
  --prop font=Georgia --prop size=38 --prop bold=true --prop color=1E2761
officecli add "$FILE" "/slide[2]" --type shape \
  --prop name=Body \
  --prop text="Enterprise renewals and the EMEA launch drove the increase. NRR held at 118%." \
  --prop x=1.5cm --prop y=4cm --prop width=30cm --prop height=3cm \
  --prop font=Calibri --prop size=20 --prop color=333333

officecli save "$FILE"
officecli validate "$FILE"
```

## QA

### Structural and text checks

Run these after saving:

```bash
officecli close "$FILE"
officecli validate "$FILE"
officecli view "$FILE" issues
officecli view "$FILE" outline
officecli view "$FILE" text
```

Reject the file if validation fails or `view issues` reports a real defect. Scan the text for `xxxx`, `lorem`, `ipsum`, `<TODO>`, `placeholder`, `TBD`, empty `()` or `[]`, and any lost currency symbol.

### Visual check

Call `render_office_preview` on the PPTX and inspect every rendered slide. Check:

- clipped or overflowing text
- shapes or charts that overlap
- text boxes that wrap into many short lines
- weak contrast, including text or icons on dark fills
- stretched, cropped, or poorly backed images
- missing arrowheads in directional diagrams
- collisions between content, citations, and footers
- margins or gaps that are too tight
- inconsistent alignment or repeated-element sizes
- a slide sequence that differs from the approved title plan

Fix the defects, save, and render the deck again. Stop after three unsuccessful fix cycles and report the remaining slide number, attempted fixes, and likely cause.

If `render_office_preview` is unavailable, inspect the HTML output and state which visual properties remain unverified. HTML cannot prove fine overlap, image cropping, exact gaps, chart rendering, animation, or target-viewer font substitution.

### Delivery gate

A PPTX is ready only when:

1. `validate` succeeds.
2. `view issues` contains no real defect.
3. The text scan contains no accidental placeholders or shell-escape damage.
4. The visual review has no known defect, or the handoff clearly states that visual QA was unavailable.
5. The final slide order matches the title plan.
6. `officecli save "$FILE"` succeeds after the last fix.

## Common mistakes

| Mistake | Correct action |
| --- | --- |
| Unquoted path with `[N]` | Quote the whole path. |
| `--name "foo"` | Use `--prop name="foo"`. |
| `/shape[myname]` | Use `/shape[@name=myname]`. |
| Treating `--index` as one-based | `--index` is zero-based; semantic paths are one-based. |
| Double-quoted currency | Single-quote the value or escape the dollar sign in an expanding heredoc. |
| Relying on theme font sizes | Set explicit font and size values. |
| Shrinking body copy to fit | Cut content or change the layout. |
| Formatting empty table cells by run path | Add the cell text first. |
| Directional connector without an arrowhead | Set `headEnd` or `tailEnd` as appropriate. |
| Editing a file open in PowerPoint | Close it in PowerPoint first. |
| Guessing a property or preset | Read the installed help. |

When a slide looks wrong, distinguish a file defect from a renderer difference. Validate the package, inspect it in the user's target viewer when possible, and do not damage correct content to work around a preview-only bug.
