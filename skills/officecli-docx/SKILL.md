---
name: officecli-docx
description: "Use for any task that reads, creates, or edits a DOCX file. This includes reports, letters, memos, proposals, templates, tracked changes, comments, headers, footers, tables of contents, and any request that names a .docx file."
---

# OfficeCLI DOCX skill

## Scope

Use OfficeCLI for every DOCX task. The bot already provides a pinned binary in E2B. Do not install or update it.

This skill explains workflow and quality checks. It does not replace the installed command reference. If a property, enum, alias, or path is uncertain, ask the binary:

```bash
officecli help docx
officecli help docx <element>
officecli help docx <verb> <element>
officecli help docx <element> --json
```

The installed help output is authoritative when it differs from this file.

## How DOCX editing works

A DOCX file is a ZIP archive of XML parts for content, styles, numbering, headers, footers, fields, comments, and relationships. OfficeCLI exposes those parts through semantic paths such as `/body/p[1]/r[2]`. Use typed commands for normal work. Use `raw-set` only when the typed API cannot represent the required XML.

OfficeCLI mutates the target on each successful call. Set the target once:

```bash
FILE="report.docx"
```

Run `officecli open "$FILE"` before editing and `officecli save "$FILE"` before another program or the delivery layer reads it. Use `officecli close "$FILE"` when no more edits are expected. A save or close can fail, so check its exit status.

## Shell rules

DOCX paths contain brackets, and text often contains dollar signs. Both need care.

1. Quote every element path: `"/body/p[1]"`.
2. Single-quote text that contains `$`: `--prop text='$50M'`.
3. OfficeCLI interprets `\n` as a soft line break and `\t` as a tab in `text=`. Use `\\n` or `\\t` only when the document needs a literal backslash sequence.
4. A JSON batch can contain a real newline as `"\n"`.
5. Check `view text` after writing shell-sensitive content.

Work in small groups of commands. After adding a style, table, field, section, header, or footer, inspect it before building on it. A long script can turn one early path mistake into many bad edits.

## Document standards

Match an existing template before applying any default from this section.

- Give a non-trivial document a real hierarchy with `Title`, `Heading1`, `Heading2`, and body styles.
- Use one readable body font. Reserve one accent color for headings, table headers, or another consistent role.
- Set paragraph spacing with `spaceBefore` and `spaceAfter`. Do not create vertical space with empty paragraphs.
- Use explicit sizes when the template styles are unreliable. A practical starting point is 18 to 20 pt for Heading 1, 14 pt for Heading 2, 12 pt bold for Heading 3, and 11 to 12 pt for body text.
- Follow the user's punctuation and language conventions. Do not force smart quotes, ornamental punctuation, or a house style onto supplied text.
- Use live fields for page numbers and other calculated values. Do not type a static value such as `Page 1`.
- Add a table of contents when the document is long enough to need navigation. Do not add one just because a heading count crossed an arbitrary threshold.
- Give every meaningful image alt text.
- Keep template instructions and placeholder tokens out of the delivered document unless the user asked for a reusable template.

## Core workflow

1. For a new file, create it. For an existing file, inspect it before editing.
2. Build or repair styles and numbering first.
3. Add sections, headings, body text, tables, images, fields, headers, and footers.
4. Apply spacing, widths, alignment, indents, and run formatting.
5. Save the file.
6. Run structural, textual, and visual QA.
7. Fix every real issue and repeat the checks.

```bash
officecli create "$FILE"
officecli open "$FILE"
officecli view "$FILE" outline
officecli view "$FILE" issues
officecli view "$FILE" text --start 1 --end 80
officecli validate "$FILE"
```

For an existing file, omit `create`.

## Inspect a document

Start with the outline, then narrow the query:

```bash
officecli view "$FILE" outline
officecli view "$FILE" annotated
officecli view "$FILE" text --start 1 --end 80
officecli view "$FILE" stats
officecli view "$FILE" issues

officecli get "$FILE" /
officecli get "$FILE" "/body/p[1]"
officecli get "$FILE" "/body/p[1]/r[1]"
officecli get "$FILE" "/body/tbl[1]" --depth 3
officecli get "$FILE" "/footer[1]" --depth 3
officecli get "$FILE" "/styles/Heading1"
officecli get "$FILE" /numbering --depth 2
```

Paths use one-based indexes. `--index` uses zero-based insertion positions. Quote paths in every shell.

Use `[last()]`, not `[last]`, for the final matching element.

Queries are useful for systematic checks:

```bash
officecli query "$FILE" 'paragraph[style=Heading1]'
officecli query "$FILE" 'p:contains("quarterly")'
officecli query "$FILE" 'p:empty'
officecli query "$FILE" 'image:no-alt'
officecli query "$FILE" 'field[fieldType=mergefield]'
```

With `--json`, query results are in `.data.results[]`.

## Create and edit content

### Paragraphs and runs

A paragraph controls style, alignment, spacing, and indentation. A run controls character formatting.

```bash
officecli add "$FILE" /body --type paragraph \
  --prop text="Executive summary" --prop style=Heading1 \
  --prop size=20pt --prop bold=true --prop spaceAfter=12pt

officecli add "$FILE" /body --type paragraph \
  --prop text="Revenue grew 18% year over year." \
  --prop style=Normal --prop size=11pt --prop spaceAfter=8pt

officecli set "$FILE" "/body/p[1]/r[1]" --prop color=1F4E79
```

Set `style=Normal` explicitly after a heading when style inheritance is uncertain. Use `indent`, `firstLineIndent`, and `hangingIndent` instead of leading spaces.

### Tables

Tables live under `/body/tbl[N]`. Rows are `tr[N]`; cells are `tc[N]`.

```bash
officecli add "$FILE" /body --type table --prop rows=4 --prop cols=3 --prop width=100%
officecli set "$FILE" "/body/tbl[1]/tr[1]" \
  --prop header=true --prop c1=Quarter --prop c2=Revenue --prop c3=Growth
officecli set "$FILE" "/body/tbl[1]/tr[1]/tc[1]/p[1]/r[1]" --prop bold=true
```

Row-level `set` handles `height`, `header`, and `c1` through `cN` text. Apply fill, borders, alignment, and font styling to the cell, paragraph, or run that owns them.

Use a paragraph bottom border for a horizontal rule:

```bash
officecli set "$FILE" "/body/p[3]" --prop pbdr.bottom="single;6;2E75B6"
```

Do not use a one-row table as a divider.

### Lists and tab stops

For a simple list, set `listStyle` on the paragraph:

```bash
officecli add "$FILE" /body --type paragraph --prop text="First item" --prop listStyle=bullet
```

For multilevel numbering, create an `abstractnum`, create a `num` that references it, then set `numId` and `ilvl` on each paragraph:

```bash
officecli add "$FILE" /numbering --type abstractnum --prop format=decimal
officecli add "$FILE" /numbering --type num --prop abstractNumId=0
officecli add "$FILE" /body --type paragraph --prop text="Section one" --prop numId=1 --prop ilvl=0
```

Inspect the assigned IDs after creating the definitions. Do not assume IDs in an existing document.

A leader requires both a tab stop and a real tab character:

```bash
officecli add "$FILE" "/body/p[1]" --type tab \
  --prop pos=6in --prop val=right --prop leader=dot
officecli set "$FILE" "/body/p[1]" --prop text="Chapter 1\t12"
```

### Fields, footers, and contents

Typed fields cover common cases:

| Field | Main properties |
| --- | --- |
| Current page | `field=page` or `fieldType=page` |
| Total pages | `field=numpages` or `fieldType=numpages` |
| Date | `fieldType=date`, optional `format` |
| Mail merge | `fieldType=mergefield`, `name` |
| Bookmark reference | `fieldType=ref`, `name` |

Use `officecli help docx field` for the full enum. When typed properties cannot express an instruction, use the `instruction` property. There is no `fieldInstr` field type.

Add first-page and default footers like this:

```bash
officecli add "$FILE" / --type footer --prop type=first --prop text=""
officecli add "$FILE" / --type footer --prop type=default \
  --prop align=center --prop size=9pt --prop text="Page " --prop field=page
```

Adding a first-page footer enables the different-first-page setting. Do not set an unsupported `differentFirstPage` property.

For "Page X of Y":

```bash
officecli add "$FILE" / --type footer --prop type=default \
  --prop text="Page " --prop align=center --prop size=9pt
officecli add "$FILE" "/footer[1]/p[1]" --type field --prop fieldType=page
officecli add "$FILE" "/footer[1]/p[1]" --type run --prop text=" of "
officecli add "$FILE" "/footer[1]/p[1]" --type field --prop fieldType=numpages
```

Before adding a table of contents, make sure its source paragraphs use built-in heading styles or a custom paragraph style with `outlineLvl`:

```bash
officecli add "$FILE" /body --type toc \
  --prop levels="1-3" --prop title="Table of contents" \
  --prop hyperlinks=true --index 0
officecli set "$FILE" /settings --prop updateFields=true
```

OfficeCLI cannot paginate the document, so Word or another compatible field engine must calculate PAGE, NUMPAGES, PAGEREF, and TOC page numbers. Verify the field structure instead of trusting cached text. Recalculate SEQ fields with:

```bash
officecli set "$FILE" / --prop recalcFields=seq
```

### Images, charts, links, and sections

Add alt text with every image:

```bash
officecli add "$FILE" "/body/p[5]" --type picture \
  --prop src=logo.png --prop width=1.5in --prop alt="Acme logo"
```

Prefer an editable native chart for data that OfficeCLI supports:

```bash
officecli add "$FILE" /body --type chart \
  --prop chartType=bar --prop title="Revenue by region" \
  --prop categories="EMEA,APAC,Americas" --prop data="2026:120,150,180"
```

External and internal links use different properties:

```bash
officecli add "$FILE" "/body/p[2]" --type hyperlink \
  --prop url="https://example.com" --prop text="Project site"
officecli add "$FILE" "/body/p[3]" --type hyperlink \
  --prop anchor=chapter1 --prop text="See chapter 1"
```

Page setup lives at the document root. Use one page-break method per boundary:

```bash
officecli set "$FILE" / \
  --prop pageWidth=12240 --prop pageHeight=15840 \
  --prop marginTop=1440 --prop marginLeft=1440
officecli add "$FILE" /body --type paragraph \
  --prop text="Introduction" --prop style=Heading1 \
  --prop pageBreakBefore=true
```

Do not add an explicit page break and `pageBreakBefore=true` at the same location.

### Review features

Use the typed revision and comment properties when possible:

```bash
officecli query "$FILE" ins
officecli query "$FILE" del
officecli set "$FILE" /revision --prop revision.action=accept
officecli add "$FILE" "/body/p[4]" --type comment \
  --prop author="AI assistant" --prop text="Confirm this date."
```

Use the author named by the user. If no author is specified, choose a neutral label instead of impersonating a person or vendor.

See `officecli help docx run` and `officecli help docx comment` before creating selective revisions, replies, or resolved comments.

## Raw XML

Use the lowest level that can express the change:

1. Typed properties such as `text`, `style`, and `bold`.
2. Dotted attributes such as `pbdr.bottom`, `ind.left`, and `shd.fill`.
3. `raw-set` with literal OOXML.

`raw-set` bypasses schema protection. Save a recoverable copy, change the smallest possible element, and run `validate` immediately.

Borders use `style;size;color;space`, for example `single;4;FF0000;1`. Hex colors do not include `#`.

## QA

Run this cycle after saving:

1. `officecli view "$FILE" issues`
2. `officecli view "$FILE" outline`
3. `officecli view "$FILE" text --max-lines 400`
4. `officecli validate "$FILE"`
5. Call `render_office_preview` on the DOCX and inspect every rendered page.
6. Fix the issues and repeat the full cycle.

The text pass should catch spelling errors, accidental `\$`, `\t`, or `\n` literals, and leaked placeholders such as `{{name}}`, `$NAME$`, `<TODO>`, `lorem`, and `xxxx`.

The visual pass should catch blank pages, clipped titles, broken tables, crowded margins, weak hierarchy, poor page balance, and unreadable colors. If preview rendering is unavailable, report that limitation. Do not claim visual verification from schema validation alone.

### Delivery gate

Set `FILE` to the real target, then run:

```bash
officecli close "$FILE"
officecli validate "$FILE"
officecli view "$FILE" issues
officecli view "$FILE" text --max-lines 400
```

Reject the file if validation fails or `view issues` reports a real defect.

If the design calls for a page footer, verify that a live PAGE field exists:

```bash
officecli query "$FILE" 'field[fieldType=page]' --json \
  | jq -e '.data.results | length >= 1'
```

If the file is a mail-merge template, verify one MERGEFIELD per slot and no literal placeholder tokens in visible content. If it contains a TOC, inspect `/toc[1]` and confirm `updateFields=true`.

Cached field values may be empty or stale until a compatible editor recalculates them. Check field XML structure, not the displayed number.

## Common mistakes

| Mistake | Correct action |
| --- | --- |
| Unquoted path with `[N]` | Quote the whole path. |
| `[last]` | Use `[last()]`. |
| Treating `--index` as one-based | `--index` is zero-based; semantic paths are one-based. |
| Empty paragraphs for spacing | Set paragraph spacing properties. |
| `listStyle` on a run | Set it on the paragraph. |
| Cell formatting on a row | Format the cell, paragraph, or run. |
| Leading spaces for indentation | Set indent properties. |
| Two page-break methods at one boundary | Keep one method. |
| Static page-number text | Add a PAGE field. |
| Editing a file open in Word | Close it in Word first. |
| Guessing an uncertain property | Read the installed help. |

When behavior still looks wrong, separate document errors from renderer differences. Validate the OOXML, inspect it in the user's target editor when possible, and do not rewrite valid content to chase a preview-only quirk.
