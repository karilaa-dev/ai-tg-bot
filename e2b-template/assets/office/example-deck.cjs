const pptxgen = require("pptxgenjs");
const { picture, text, save } = require("/opt/office/node/pptx-helpers.cjs");
async function main() {
  const deck = new pptxgen();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "ai-tg-bot";
  deck.subject = "Office capability contract";
  deck.theme = {
    headFontFace: "Carlito",
    bodyFontFace: "Carlito",
    lang: "en-US",
  };
  let slide = deck.addSlide();
  text(
    slide,
    "Office tools contract",
    { x: 0.6, y: 0.4, w: 12, h: 0.8 },
    { fontSize: 32, bold: true },
  );
  text(slide, "Readable text and embedded artwork", {
    x: 0.6,
    y: 1.5,
    w: 6,
    h: 1,
  });
  if (process.argv[3])
    picture(slide, process.argv[3], { x: 7, y: 1.5, w: 5, h: 4 });
  slide = deck.addSlide();
  text(
    slide,
    "Table and chart",
    { x: 0.6, y: 0.4, w: 12, h: 0.8 },
    { fontSize: 32, bold: true },
  );
  slide.addTable(
    [
      ["Quarter", "Sales"],
      ["Q1", "10"],
      ["Q2", "20"],
    ],
    {
      x: 0.6,
      y: 1.6,
      w: 4,
      h: 2,
      fontFace: "Carlito",
      fontSize: 20,
      border: { pt: 1, color: "BBC5D0" },
    },
  );
  slide.addChart(
    deck.ChartType.bar,
    [{ name: "Sales", labels: ["Q1", "Q2"], values: [10, 20] }],
    {
      x: 5.4,
      y: 1.6,
      w: 7,
      h: 4,
      showLegend: false,
      showTitle: false,
      catAxisLabelFontFace: "Carlito",
      valAxisLabelFontFace: "Carlito",
    },
  );
  await save(deck, process.argv[2]);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
