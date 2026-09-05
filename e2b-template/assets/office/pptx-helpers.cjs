function picture(slide, path, box, fit = "contain") {
  if (
    ![box.x, box.y, box.w, box.h].every(Number.isFinite) ||
    box.w <= 0 ||
    box.h <= 0
  )
    throw new Error("Invalid image box");
  if (!["contain", "crop"].includes(fit)) throw new Error("Invalid image fit");
  slide.addImage({
    path,
    ...box,
    sizing: { type: fit === "crop" ? "cover" : "contain", w: box.w, h: box.h },
  });
}
function text(slide, value, box, options = {}) {
  if (
    !value ||
    ![box.x, box.y, box.w, box.h].every(Number.isFinite) ||
    box.w <= 0 ||
    box.h <= 0
  )
    throw new Error("Invalid text or box");
  slide.addText(value, {
    fontFace: "Carlito",
    fontSize: 20,
    color: "182230",
    breakLine: false,
    margin: 0,
    ...box,
    ...options,
  });
}
async function save(deck, fileName) {
  const JSZip = require("jszip");
  const fs = require("node:fs/promises");
  const zip = await JSZip.loadAsync(
    await deck.write({ outputType: "nodebuffer" }),
  );
  // PptxGenJS 4.0.1 emits an unused slideMaster override for each extra slide.
  // Remove only those declarations, without changing any actual package part.
  const types = await zip.file("[Content_Types].xml").async("string");
  zip.file(
    "[Content_Types].xml",
    types.replace(
      /<Override PartName="(\/ppt\/slideMasters\/slideMaster\d+\.xml)"[^>]*\/>/g,
      (entry, name) => (zip.file(name.slice(1)) ? entry : ""),
    ),
  );
  await fs.writeFile(
    fileName,
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  );
}
module.exports = { picture, text, save };
