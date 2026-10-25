import { describe, expect, it } from "vitest";
import { validateOpenUi, safeOpenUi } from "../../src/openui/validate.js";

const flowStep = 'FlowStep("Root cause", "The invalid certificate rejected new connections.", "issue")';
const stat = 'Stat("12 min", "Outage", "issue")';
const item = 'Item("Restaurant", "file:42", ["Dumplings", "Downtown"], "A suitable shared meal.", [Link("Source", "https://example.com/place")])';

describe("trusted visual compositions", () => {
  it("accepts linked recommendation rows, causal chains and evidence panels together", () => {
    const source = `root = Stack([Flow("Cause and effect", [${flowStep},FlowStep("Recovered", "Renewing the certificate restored access.", "success")], ""),StatGrid("Evidence", [${stat},Stat("0", "Lost records", "default")], "Measured during the incident."),ItemList("Places", [${item}])])`;
    expect(validateOpenUi(validateOpenUi(source))).toBe(validateOpenUi(source));
  });

  it.each([
    `root = Stack([${flowStep}])`,
    `root = Stack([Card("Wrong placement", [${stat}])])`,
    `root = Stack([${item}])`,
    'root = Stack([Link("Source", "https://example.com")])',
    `root = Stack([Flow("Wrong child", [${flowStep},Text("not a step")], "")])`,
    `root = Stack([StatGrid("Wrong child", [${stat},${flowStep}], "")])`,
    `root = Stack([ItemList("Wrong child", [${stat}])])`,
    'root = Stack([ItemList("Wrong link", [Item("Name", "", [], "", [Text("not a link")])])])',
    `root = Stack([Grid([ItemList("Wrong layout", [${item}])])])`,
    `root = Stack([Flow("Too short", [${flowStep}], "")])`,
    `root = Stack([StatGrid("Too short", [${stat}], "")])`,
    'root = Stack([Flow("Wrong status", [FlowStep("A", "", "red"),FlowStep("B", "", "default")], "")])',
  ])("rejects malformed component placement: %s", source => {
    expect(safeOpenUi(source)).toBeUndefined();
  });

  it.each(["javascript:alert(1)", "data:text/html,hello", "http://example.com", "https://user:secret@example.com", "/api/chat/session", "file:42"])("rejects unsafe nested link %s", url => {
    expect(safeOpenUi(`root = Stack([ItemList("Places", [Item("Name", "", [], "", [Link("Source", ${JSON.stringify(url)})])])])`)).toBeUndefined();
  });

  it("counts thumbnails and gallery images together at the twelve-image limit", () => {
    const items = Array(8).fill(item).join(",");
    const image = 'Image("file:43", "Photo", "")';
    const source = (count: number) => `root = Stack([ItemList("Places", [${items}]),Grid([${Array(count).fill(image).join(",")}])])`;
    expect(safeOpenUi(source(4))).toBeDefined();
    expect(safeOpenUi(source(5))).toBeUndefined();
  });
});
