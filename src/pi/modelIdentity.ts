import type { Context } from "@earendil-works/pi-ai";

export function modelDisplayName(model: { id: string; name: string }): string {
  const id = model.id.split("/").at(-1)!;
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-(.+))?$/iu.exec(id);
  const name = gpt
    ? `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ")}` : ""}`
    : model.name !== model.id ? model.name.replace(/^[^:]+:\s*/u, "") : id;
  return name.replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 160);
}

// Request-local metadata: never modify the session prompt or persisted messages.
export function withModelIdentity(context: Context, model: { id: string; name: string }): Context {
  return { ...context, systemPrompt: `${context.systemPrompt ?? ""}\n\nModel: ${modelDisplayName(model)}`.trim() };
}
