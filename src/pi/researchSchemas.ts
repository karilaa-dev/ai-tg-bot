import { Type, type TSchema } from "@earendil-works/pi-ai";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const error = Type.Object({ error: Type.String(), file_id: Type.Optional(Type.Number()), message: Type.Optional(Type.String()) });
const snippet = { snippet: Type.String(), score: Type.Number() };
const chunk = {
  chunk_id: Type.Number(), chunk_index: Type.Optional(Type.Number()),
  heading_path: Type.Optional(nullableString), ...snippet,
};

const schemas: Record<string, TSchema> = {
  search_thread: Type.Object({ results: Type.Array(Type.Union([
    Type.Object({ kind: Type.Literal("message"), message_id: Type.Number(), role: Type.Optional(Type.String()), date_iso: Type.Optional(Type.String()), ...snippet }),
    Type.Object({ kind: Type.Literal("chunk"), ...chunk }),
  ])) }),
  search_in_file: Type.Object({ results: Type.Array(Type.Object(chunk)) }),
  read_file_section: Type.Union([
    Type.Object({ content: Type.String() }),
    Type.Object({ outline: Type.Array(Type.Object({ chunk_index: Type.Number(), heading_path: nullableString })) }),
  ]),
  web_search: Type.Object({
    provider: Type.Optional(Type.String()),
    answer: Type.Optional(Type.String()),
    warning: Type.Optional(Type.String()),
    results: Type.Array(Type.Object({ title: Type.String(), url: Type.String(), snippet: Type.String(), published_date: Type.Optional(Type.String()) })),
    images: Type.Optional(Type.Array(Type.Object({ url: Type.String(), description: nullableString }))),
  }),
  web_extract: Type.Object({
    provider: Type.Literal("tavily"),
    results: Type.Array(Type.Object({ url: Type.String(), content: Type.String(), truncated: Type.Boolean(), chars: Type.Number(), images: Type.Optional(Type.Array(Type.String())), favicon: Type.Optional(Type.String()) })),
    failed_results: Type.Array(Type.Object({ url: Type.String(), error: Type.String() })),
    response_time: Type.Optional(Type.Number()), request_id: Type.Optional(Type.String()),
  }),
  load_message: Type.Object({
    message_id: Type.Number(), role: Type.String(), kind: nullableString, text: Type.String(), truncated: Type.Boolean(),
    files: Type.Array(Type.Object({
      file_id: Type.Number(), marker: Type.String(), type: Type.String(), name: Type.String(), summary: nullableString,
      inline: Type.Boolean(), bash_input_file_id: Type.Number(), source_only: Type.Boolean(), recommended_tool: Type.String(),
    })),
    images: Type.Array(Type.Object({ file_id: Type.Number(), marker: Type.String(), name: Type.String(), caption: nullableString, note: Type.String() })),
    materialized_file_ids: Type.Array(Type.Number()), durable_file_ids: Type.Array(Type.Number()), sandbox_file_ids: Type.Array(Type.Number()),
  }),
};

export function researchOutputSchema(name: string): TSchema | undefined {
  const success = schemas[name];
  return success ? Type.Union([success, error]) : undefined;
}
