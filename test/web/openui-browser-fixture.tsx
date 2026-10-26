import { fixtureUuid } from "./uuid-fixtures.js";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { GenerativeResponse } from "../../src/web/client/openui-response.js";
import { bindChatRequests, chatApi, chatFetch } from "../../src/web/client/chat/api.js";
import { savedRestaurantOpenUi } from "./openui-saved-fixture.js";
import { openUiVisualExamples } from "./openui-visual-fixtures.js";
import "../../src/web/client/style.css";

const imageSource = { threadId: fixtureUuid(7), source: { url: chatApi.fileUrl, fetch: chatFetch } };
const visuals = `root = Stack([Grid([Image("file:${fixtureUuid(42)}", "A saved route photograph", "Photograph attached to this chat"), Card("At a glance", [Metric("Distance", "9 km", "Valley route"), Metric("Time", "3 hours", "With breaks")])]), BarChart("Walking distance", ["Valley", "Ridge"], ["9", "14"], "km"), Steps("Day plan", ["09:00 · Trailhead", "12:00 · Lake"], ["Start the walk", "Pause for lunch"]), Button("Compare the climbs", "Compare the elevation gain of these routes.")])`;
const examples: Record<string, string> = {
  visuals,
  restaurants: savedRestaurantOpenUi,
  explanation: openUiVisualExamples.combined,
  unsafe: `root = Stack([Image("file:${fixtureUuid(43)}", "Unsafe format", "Description remains available")])`,
  denied: `root = Stack([Image("file:${fixtureUuid(44)}", "Private picture", "Description remains available")])`,
  expired: `root = Stack([Image("file:${fixtureUuid(45)}", "Expired account", "Description remains available")])`,
  slow: `root = Stack([Image("file:${fixtureUuid(46)}", "Slow picture", "Description remains available")])`,
  sandbox: `root = Stack([Image("file:${fixtureUuid(47)}", "Sleeping sandbox", "Description remains available")])`,
  large: `root = Stack([Image("file:${fixtureUuid(48)}", "Large picture", "Description remains available")])`,
  broken: `root = Stack([Image("file:${fixtureUuid(49)}", "Broken picture", "Description remains available")])`,
  malicious: 'root = Stack([Image("https://outside.invalid/track.png", "External picture", "Never load this")])',
  partial: `root = Stack([Image("file:${fixtureUuid(42)}",`,
  literal: 'root = Stack([Text("<script>window.injected = true</script>")])',
};

function Fixture() {
  const [example, setExample] = useState("visuals");
  const [enabled, setEnabled] = useState(true);
  const [authenticated, setAuthenticated] = useState(true);
  const [lastAction, setLastAction] = useState("");
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const listener = () => setExpired(true);
    window.addEventListener("chat-session-expired", listener);
    return () => window.removeEventListener("chat-session-expired", listener);
  }, []);
  return <main style={{ maxWidth: 720, margin: "0 auto", padding: 16 }}>
    <h1>OpenUI browser fixture</h1>
    <p>Complete fallback: The valley route is 9 km and takes 3 hours with breaks. The ridge route is 14 km. Start at 09:00, then pause by the lake at noon. The picture shows the saved route.</p>
    <label>Example <select aria-label="Example" value={example} onChange={event => setExample(event.target.value)}>{Object.keys(examples).map(name => <option key={name}>{name}</option>)}</select></label>
    <label><input type="checkbox" checked={authenticated} onChange={event => setAuthenticated(event.target.checked)} />Image access</label>
    <label><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Show UI</label>
    <output aria-label="Last action">{lastAction}</output>
    <output aria-label="Session status">{expired ? "expired" : "active"}</output>
    {enabled && <GenerativeResponse source={examples[example] ?? ""} onAction={setLastAction} imageSource={authenticated ? imageSource : undefined} />}
  </main>;
}

bindChatRequests(1001);
const root = document.getElementById("root");
if (!root) throw new Error("Fixture root is missing");
createRoot(root).render(<StrictMode><Fixture /></StrictMode>);
