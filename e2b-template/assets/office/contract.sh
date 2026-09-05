#!/usr/bin/env bash
set -euo pipefail
task_dir=$(mktemp -d)
trap 'rm -rf "$task_dir"' EXIT
cd "$task_dir"
docx --version | grep -F '0.25.0'
office-python - <<'PY'
import pptx, openpyxl
assert pptx.__version__ == '1.0.2'
assert openpyxl.__version__ == '3.1.5'
PY
pptxgenjs-run -e 'if (new (require("pptxgenjs"))().version !== "4.0.1") throw new Error("Unexpected PptxGenJS version")'
cat > draft.md <<'MD'
# Office contract

A **formatted** paragraph with [Client Name] and a targeted edit.

| Quarter | Sales |
| --- | --- |
| Q1 | 10 |
| Q2 | 20 |
MD
docx create contract.docx --from draft.md
docx replace contract.docx '[Client Name]' 'Acme'
docx track-changes contract.docx on
docx replace contract.docx 'targeted edit' 'reviewed edit'
docx comments add contract.docx --anchor 'Acme' --text 'Verified client name'
docx read contract.docx --current | grep -F 'Acme'
docx comments list contract.docx | grep -F 'Verified client name'
docx validate contract.docx --json >/dev/null
office-python - <<'PY'
from zipfile import ZipFile
from lxml import etree
with ZipFile('contract.docx') as z:
    root = etree.fromstring(z.read('word/document.xml'))
    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
    for tag in ['b', 'tbl', 'ins', 'del', 'commentRangeStart']:
        assert root.find('.//w:' + tag, ns) is not None, tag
PY
office-python -c 'from PIL import Image; Image.new("RGB", (640, 360), "steelblue").save("artwork.png")'
pptxgenjs-run /opt/office/node/example-deck.cjs contract.pptx "$task_dir/artwork.png"
office-python - <<'PY'
from pptx import Presentation
from openpyxl import Workbook
from zipfile import ZipFile
from lxml import etree
p = Presentation('contract.pptx')
p.slides[0].shapes[0].text_frame.paragraphs[0].runs[0].text = 'Edited Office tools contract'
p.save('edited.pptx')
with ZipFile('contract.pptx') as original, ZipFile('edited.pptx') as edited:
    def canonical(data):
        return etree.tostring(etree.fromstring(data, etree.XMLParser(remove_blank_text=True)), method='c14n')
    for name in original.namelist():
        if not name.endswith('/') and name.startswith(('ppt/media/', 'ppt/theme/', 'ppt/slideMasters/', 'ppt/embeddings/')):
            before, after = original.read(name), edited.read(name)
            assert (canonical(before) == canonical(after) if name.endswith(('.xml', '.rels')) else before == after), name
    assert canonical(original.read('ppt/slides/slide2.xml')) == canonical(edited.read('ppt/slides/slide2.xml'))
b = Workbook()
s = b.active
s.title = 'Sales'
s.append(['Quarter','Sales'])
s.append(['Q1',10])
s.append(['Q2',20])
s['B4'] = '=SUM(B2:B3)'
s['B5'] = '=IF(A5="","",A5*2)'
s.print_area = 'A1:B5'
s.sheet_properties.pageSetUpPr.fitToPage = True
s.page_setup.fitToWidth = 1
s.page_setup.fitToHeight = 1
b.save('contract.xlsx')
PY
for source in contract.docx contract.pptx edited.pptx contract.xlsx; do
  office-files validate "$task_dir/$source" "$task_dir/qa-$source" > "$source.json"
  jq -e '.page_count > 0 and (.checks | length > 1) and all(.checks[]; .status == "passed")' "$source.json" >/dev/null || { cat "$source.json" >&2; exit 1; }
  pdf=$(jq -r .pdf_path "$source.json")
  office-files pages "$pdf" "$task_dir/qa-$source" 1 >/dev/null
  test -s "$task_dir/qa-$source/page-1.jpg"
  jq -c '{file:"'"$source"'",pages:.page_count,elapsed_ms,peak_child_rss_kib,renderer_version}' "$source.json"
  jq -e '.elapsed_ms < 120000 and .peak_child_rss_kib < 1572864' "$source.json" >/dev/null
done
office-python - <<'PY'
from pathlib import Path
from zipfile import ZipFile
from lxml import etree
from openpyxl import load_workbook
with ZipFile('contract.docx') as original:
    for variant in ['missing-part', 'missing-relationship', 'bad-xml']:
        with ZipFile(variant + '.docx', 'w') as broken:
            for name in original.namelist():
                if variant == 'missing-part' and name == 'word/document.xml':
                    continue
                data = original.read(name)
                if variant == 'missing-relationship' and name == '_rels/.rels':
                    root = etree.fromstring(data)
                    root[0].set('Target', 'missing.xml')
                    data = etree.tostring(root)
                if variant == 'bad-xml' and name == 'word/document.xml':
                    data = b'<broken'
                broken.writestr(name, data)
Path('corrupt.docx').write_bytes(b'not a ZIP')
b = load_workbook('contract.xlsx')
b.active['B4'] = '=1/0'
b.save('bad-formula.xlsx')
PY
for source in corrupt.docx missing-part.docx missing-relationship.docx bad-xml.docx bad-formula.xlsx; do
  office-files validate "$task_dir/$source" "$task_dir/qa-$source" > "$source.json"
  jq -e 'any(.checks[]; .status == "failed")' "$source.json" >/dev/null
done
office-python /opt/office/tests/office-regressions.py "$task_dir" "$(command -v office-files)"
# A missing renderer must produce an explicit unavailable status, never approval.
mkdir no-renderer
ln -s /usr/local/bin/docx no-renderer/docx
PATH="$task_dir/no-renderer" /usr/local/bin/office-files validate "$task_dir/contract.docx" "$task_dir/no-renderer-qa" > unavailable.json
jq -e 'any(.checks[]; .name == "actual_file_render" and .status == "unavailable")' unavailable.json >/dev/null
printf 'Office creation, preservation, rendering, formula and corruption contracts passed\n'
printf 'Office runtime footprint (KiB):\n'
du -sk /opt/office /usr/lib/libreoffice /usr/share/libreoffice /usr/share/fonts
printf 'LibreOffice and font package installed size (KiB): '
dpkg-query -W -f='${Package} ${Installed-Size}\n' | awk '/^(libreoffice|fonts-crosextra|fonts-liberation)/ {total += $2} END {print total}'
if [[ -r /sys/fs/cgroup/memory.peak ]]; then
  printf 'Sandbox cgroup peak memory (bytes): '
  cat /sys/fs/cgroup/memory.peak
fi
