// Exercise the npm implementation in an isolated process: an uncaught stream error
// must fail the test rather than terminate the entire test runner.
import { createServer } from "node:net";
import { once } from "node:events";
import { Agent, fetch } from "undici/index.js";

const response = Buffer.from("HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n");
const server = createServer(socket => { socket.once("data", () => socket.end(response)); });
await once(server.listen(0, "127.0.0.1"), "listening");
const dispatcher = new Agent();
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  let rejected = false;
  try { await fetch(`http://127.0.0.1:${address.port}`, { dispatcher, signal: AbortSignal.timeout(2_000) }); }
  catch (error) {
    if (!(error instanceof Error) || !(error.cause instanceof Error) || !error.cause.message.includes("content-encoding")) throw error;
    rejected = true;
  }
  if (!rejected) throw new Error("Expected excessive encoding rejection");
  await dispatcher.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  // Give any orphaned stream error a turn on the event loop.
  await new Promise(resolve => setTimeout(resolve, 50));
  console.log("safe rejection");
} finally { server.close(); await dispatcher.destroy(); }
