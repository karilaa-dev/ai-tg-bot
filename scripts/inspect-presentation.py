"""Small visual-content regression signal; rendered slides still need design review."""
import json
import sys
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

NS = {"p": "http://schemas.openxmlformats.org/presentationml/2006/main", "a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


def inspect(filename):
    with ZipFile(filename) as package:
        presentation = ET.fromstring(package.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        area = int(size.get("cx")) * int(size.get("cy"))
        slide_names = sorted((n for n in package.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")), key=lambda n: int(Path(n).stem[5:]))
        slides = []
        for name in slide_names:
            root = ET.fromstring(package.read(name))
            pictures = root.findall(".//p:pic", NS)
            meaningful_images = 0
            for picture in pictures:
                extent = picture.find("p:spPr/a:xfrm/a:ext", NS)
                if extent is not None and int(extent.get("cx")) * int(extent.get("cy")) / area >= 0.15:
                    meaningful_images += 1
            text = [element.text for element in root.findall(".//a:t", NS) if element.text]
            slides.append({"slide": len(slides) + 1, "pictures": len(pictures), "largeImages": meaningful_images, "text": text})
        return {"slides": slides, "slideCount": len(slides), "imageCount": sum(s["pictures"] for s in slides), "slidesWithLargeImages": sum(s["largeImages"] > 0 for s in slides)}


if __name__ == "__main__":
    result = inspect(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if "--check-city" in sys.argv[2:]:
        assert result["slidesWithLargeImages"] >= 2, "City presentation regression: fewer than two slides show substantial imagery"
