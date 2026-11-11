// مخزن خدمة الدمج: كل شيء في Turso (مهام، أجزاء المصادر، Blobs الناتج) — لا S3 ولا خدمات خارجية
// قاعدة ذهبية: كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso) ويُقرأ تدفقيًا بصفحات
import { db, ensureSchema, nowIso } from "../turso";
import { MERGE_LIMITS } from "../config";
import { randomUUID } from "crypto";

export type JobStatus = "queued" | "uploading" | "processing" | "done" | "failed";

export interface JobRow {
  id: string;
  status: JobStatus;
  progress: number;
  error: string | null;
  video_size: number | null;
  duration: number | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface SourceRow {
  job_id: string;
  seq: number;
  kind: "url" | "file";
  url: string | null;
  name: string | null;
  size: number | null;
  mime: string | null;
  uploaded_bytes: number;
}

export function newJobId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function rowToJob(r: Record<string, unknown>): JobRow {
  return {
    id: String(r.id),
    status: r.status as JobStatus,
    progress: Number(r.progress ?? 0),
    error: (r.error as string) ?? null,
    video_size: (r.video_size as number) ?? null,
    duration: (r.duration as number) ?? null,
    resolution: (r.resolution as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    expires_at: String(r.expires_at),
  };
}

export async function getJob(jobId: string): Promise<JobRow | null> {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM jobs WHERE id = ?", args: [jobId] });
  return r.rows.length ? rowToJob(r.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function updateJob(jobId: string, patch: Partial<Omit<JobRow, "id" | "created_at" | "expires_at">>): Promise<void> {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  sets.push("updated_at = ?");
  args.push(nowIso());
  args.push(jobId);
  await db().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args: args as never });
}

// استحواذ متفائل على المهمة قبل المعالجة — يمنع تنفيذ الدمج مرتين من مثيلين مختلفين.
// يسمح أيضًا باستعادة المهام المتعطلة (processing أقدم من 5 دقائق دون تحديث = مثيل مات).
export async function claimJob(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job) return false;
  if (job.status === "done" || job.status === "failed") return false;
  const staleMs = 5 * 60 * 1000;
  const isStale = job.status === "processing" && Date.now() - Date.parse(job.updated_at) > staleMs;
  if (job.status === "processing" && !isStale) return false;
  const r = await db().execute({
    sql: "UPDATE jobs SET status = 'processing', progress = 0, error = NULL, updated_at = ? WHERE id = ? AND updated_at = ?",
    args: [nowIso(), jobId, job.updated_at],
  });
  return r.rowsAffected > 0;
}

export async function insertSources(jobId: string, sources: Array<{ kind: "url" | "file"; url?: string; name?: string; size?: number; mime?: string }>): Promise<void> {
  await ensureSchema();
  const stmts = sources.map((s, seq) => ({
    sql: "INSERT INTO sources (job_id, seq, kind, url, name, size, mime, uploaded_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
    args: [jobId, seq, s.kind, s.url ?? null, s.name ?? null, s.size ?? null, s.mime ?? null] as never,
  }));
  await db().batch(stmts, "write");
}

export async function listSources(jobId: string): Promise<SourceRow[]> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC",
    args: [jobId],
  });
  return r.rows.map((row) => {
    const o = row as unknown as Record<string, unknown>;
    return {
      job_id: String(o.job_id),
      seq: Number(o.seq),
      kind: o.kind as "url" | "file",
      url: (o.url as string) ?? null,
      name: (o.name as string) ?? null,
      size: (o.size as number) ?? null,
      mime: (o.mime as string) ?? null,
      uploaded_bytes: Number(o.uploaded_bytes ?? 0),
    };
  });
}

export async function addSourceBytes(jobId: string, seq: number, bytes: number): Promise<void> {
  await db().execute({
    sql: "UPDATE sources SET uploaded_bytes = uploaded_bytes + ? WHERE job_id = ? AND seq = ?",
    args: [bytes, jobId, seq],
  });
}

export async function insertSourceChunk(jobId: string, seq: number, chunk: number, data: Uint8Array): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: "INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk, data) VALUES (?, ?, ?, ?)",
    args: [jobId, seq, chunk, data as never],
  });
}

// كتابة ملف الناتج إلى قاعدة البيانات صفوفًا من 2MB — قراءة الملف شرائحًا حفاظًا على الذاكرة
export async function writeOutputFile(jobId: string, filePath: string, onProgress?: (ratio: number) => Promise<void>): Promise<number> {
  const { open, stat } = await import("fs/promises");
  const st = await stat(filePath);
  const total = st.size;
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(MERGE_LIMITS.blobChunkBytes);
    let offset = 0;
    let chunk = 0;
    let batch: Array<{ sql: string; args: never }> = [];
    while (offset < total) {
      const { bytesRead } = await fh.read(buf, 0, MERGE_LIMITS.blobChunkBytes, offset);
      if (bytesRead <= 0) break;
      const slice = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + bytesRead));
      batch.push({
        sql: "INSERT OR REPLACE INTO output_chunks (job_id, chunk, data) VALUES (?, ?, ?)",
        args: [jobId, chunk, slice] as never,
      });
      chunk++;
      offset += bytesRead;
      if (batch.length >= 2) {
        // دفعة صغيرة (4MB) لتبقى ضمن حدود HTTP في Turso
        await db().batch(batch, "write");
        batch = [];
        if (onProgress) await onProgress(offset / total);
      }
    }
    if (batch.length) await db().batch(batch, "write");
    return total;
  } finally {
    await fh.close();
  }
}

// سكب أجزاء مصدر مرفوع إلى ملف في /tmp — قراءة صفحات صغيرة حفاظًا على الذاكرة
export async function dumpSourceChunksToFile(jobId: string, seq: number, filePath: string): Promise<number> {
  const { open } = await import("fs/promises");
  const fh = await open(filePath, "w");
  let written = 0;
  let cursor = 0;
  try {
    for (;;) {
      const r = await db().execute({
        sql: `SELECT chunk, data FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk >= ? ORDER BY chunk ASC LIMIT ${MERGE_LIMITS.blobPageRows}`,
        args: [jobId, seq, cursor],
      });
      if (!r.rows.length) break;
      for (const row of r.rows) {
        const o = row as unknown as Record<string, unknown>;
        const data = toU8(o.data);
        await fh.write(data);
        written += data.length;
        cursor = Number(o.chunk) + 1;
      }
    }
  } finally {
    await fh.close();
  }
  return written;
}

// بث نطاق بايتات من ملف الناتج مباشرة من قاعدة البيانات (يدعم Range 206 دون تحميل كامل)
export function readOutputRange(jobId: string, start: number, end: number): ReadableStream<Uint8Array> {
  const CH = MERGE_LIMITS.blobChunkBytes;
  const first = Math.floor(start / CH);
  const last = Math.floor(end / CH);
  let cursor = first;
  let closed = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed || cursor > last) {
        if (!closed) {
          closed = true;
          controller.close();
        }
        return;
      }
      const r = await db().execute({
        sql: `SELECT chunk, data FROM output_chunks WHERE job_id = ? AND chunk >= ? AND chunk <= ? ORDER BY chunk ASC LIMIT ${MERGE_LIMITS.blobPageRows}`,
        args: [jobId, cursor, last],
      });
      if (!r.rows.length) {
        closed = true;
        controller.close();
        return;
      }
      for (const row of r.rows) {
        const o = row as unknown as Record<string, unknown>;
        const ci = Number(o.chunk);
        const data = toU8(o.data);
        const chunkStart = ci * CH;
        let from = 0;
        let to = data.length;
        if (ci === first) from = start - chunkStart;
        if (ci === last) to = end - chunkStart + 1;
        if (to > from) controller.enqueue(data.subarray(from, to));
        cursor = ci + 1;
      }
      if (cursor > last && !closed) {
        closed = true;
        controller.close();
      }
    },
    cancel() {
      closed = true;
    },
  });
}

function toU8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  return new Uint8Array(0);
}

// بعد نجاح الدمج احذف أجزاء المصادر — الناتج فقط هو المطلوب
export async function deleteSourceChunks(jobId: string): Promise<void> {
  await db().execute({ sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] });
}

// حذف شامل لمهمة (jobs + sources + source_chunks + output_chunks) في دفعة واحدة
export async function deleteJobCascade(jobId: string): Promise<void> {
  await ensureSchema();
  await db().batch(
    [
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [jobId] as never },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [jobId] as never },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [jobId] as never },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [jobId] as never },
    ],
    "write"
  );
}
