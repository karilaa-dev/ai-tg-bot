import { sql, type SQL } from "drizzle-orm";
import { valueList, type SqlExecutor } from "../sql.js";
import type { EmbeddingRow } from "../types.js";

export type EmbeddingKind = "message" | "chunk";

export class EmbeddingsRepo {
  constructor(private readonly db: SqlExecutor) {}

  async upsert(kind: EmbeddingKind, refId: number, vector: Float32Array, model: string | null = null): Promise<void> {
    const buffer = vectorToBuffer(vector);
    await this.db.execute(sql`
      insert into embeddings(kind, ref_id, model, dim, vector, created_at)
      values (${kind}, ${refId}, ${model}, ${vector.length}, ${buffer}, ${Date.now()})
      on conflict (kind, ref_id) do update set
        model = excluded.model,
        dim = excluded.dim,
        vector = excluded.vector
    `);
  }

  async list(kind: EmbeddingKind, refIds: number[], model?: string): Promise<Array<EmbeddingRow & { decoded: Float32Array }>> {
    if (!refIds.length) return [];
    const filters: SQL[] = [sql`kind = ${kind}`];
    if (model) filters.push(sql`model = ${model}`);
    filters.push(sql`ref_id in (${valueList(refIds)})`);
    const rows = await this.db.query<EmbeddingRow>(
      sql`select * from embeddings where ${sql.join(filters, sql` and `)}`,
    );
    return rows.map((row) => ({ ...row, decoded: bufferToVector(row.vector, row.dim) }));
  }

  async deleteRefs(kind: EmbeddingKind, refIds: number[]): Promise<void> {
    if (!refIds.length) return;
    await this.db.execute(sql`delete from embeddings where kind = ${kind} and ref_id in (${valueList(refIds)})`);
  }
}

export function vectorToBuffer(vector: Float32Array): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let i = 0; i < vector.length; i += 1) buffer.writeFloatLE(vector[i] ?? 0, i * 4);
  return buffer;
}

export function bufferToVector(buffer: Buffer, dim: number): Float32Array {
  const vector = new Float32Array(dim);
  for (let i = 0; i < dim; i += 1) vector[i] = buffer.readFloatLE(i * 4);
  return vector;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aMag += av * av;
    bMag += bv * bv;
  }
  if (!aMag || !bMag) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}
