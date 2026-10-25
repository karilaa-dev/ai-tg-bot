const flow = [
  'root = Stack([why])',
  'why = Flow("How the weak keys became trusted", [FlowStep("Strong keys generated", "eMudhra generated strong keys inside hardware security modules.", "default"), FlowStep("Export script bug", "A change to the key-generation script produced a second key set with extremely low entropy.", "issue"), FlowStep("Wrong keys selected", "The weak keys had similar labels and were used for certificate signing requests.", "warning"), FlowStep("Certificates became trusted", "The root CA signed the weak public keys, so they joined trusted certificate chains.", "default")], "Nobody needed to steal a key: it could be recomputed from public certificates.")',
].join("\n");

const stats = [
  'root = Stack([keys])',
  'keys = StatGrid("Actual private key values", [Stat("4", "", "issue"), Stat("56", "", "issue"), Stat("66", "", "issue"), Stat("115", "", "issue"), Stat("155", "", "issue"), Stat("156", "", "issue"), Stat("230", "", "issue"), Stat("237", "", "issue")], "All eight keys were smaller than 256, requiring at most 256 guesses per key.")',
].join("\n");

const places = [
  'root = Stack([picks])',
  'picks = ItemList("Other places worth trying", [broiler, lamar, garlic])',
  'broiler = Item("Broiler Bay Hamburgers", "file:42", ["Burgers", "$$"], "Old-school local burger shop. Try a cheeseburger with homemade onion rings.", [Link("Example guide", "https://www.example.org/broiler-bay")])',
  'lamar = Item("La Mar Cocina Peruana", "", ["Peruvian", "$$$$", "Lincoln Square"], "Excellent for ceviche, seafood and a more interesting upscale dinner.", [Link("Example review", "https://reviews.example.com/la-mar"), Link("Map", "https://www.openstreetmap.org/search?query=La%20Mar%20Bellevue")])',
  'garlic = Item("Garlic Crush", "", ["Mediterranean", "$$"], "Fast and casual. Chicken shawarma, kebab plates and their signature garlic sauce.", [])',
].join("\n");

const combined = [
  'root = Stack([why, keys, picks])',
  ...flow.split("\n").slice(1),
  ...stats.split("\n").slice(1),
  ...places.split("\n").slice(1),
].join("\n");

export const openUiVisualExamples = { flow, stats, places, combined };
