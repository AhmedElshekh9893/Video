// عمليات جدول المهام (tasks) — إنشاء/قراءة/تحديث جزئي/إحصائيات
import { db, ensureSchema, nowIso, asNum } from "./turso";

export interface TaskAttempt {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskRow["status"];
  progress?: number;
  result_urls_json?: string | null;
  error_message?: string | null;
}

function rowToTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as TaskRow["type"],
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: r.status as TaskRow["status"],
    progress: asNum(r.progress),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    completed_at: (r.completed_at as string) ?? null,
  };
}

export async function insertTask(t: {
  id: string;
  provider?: string | null;
  model: string;
  type: TaskRow["type"];
  prompt: string;
  params_json?: string;
  status?: TaskRow["status"];
}): Promise<void> {
  await ensureSchema();
  const now = nowIso();
  await db().execute({
    sql: `INSERT INTO tasks (id, provider, model, type, prompt, params_json, status, progress, attempts_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, '[]', ?, ?)`,
    args: [t.id, t.provider ?? null, t.model, t.type, t.prompt, t.params_json ?? "{}", t.status ?? "processing", now, now],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  if (!r.rows.length) return null;
  return rowToTask(r.rows[0] as unknown as Record<string, unknown>);
}

// تحديث جزئي (patch) — يضبط updated_at دائمًا و completed_at تلقائيًا عند الاكتمال
export async function updateTask(id: string, patch: TaskPatch): Promise<void> {
  await ensureSchema();
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(v);
  }
  sets.push("updated_at = ?");
  args.push(nowIso());
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, ?)");
    args.push(nowIso());
  }
  args.push(id);
  await db().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args: args as never });
}

// إضافة محاولة إلى سجل المحاولات (attempts_json) — يوثّق كل مفتاح جرّبناه ونتيجته
export async function appendAttempt(id: string, attempt: TaskAttempt): Promise<void> {
  const t = await getTask(id);
  if (!t) return;
  let attempts: TaskAttempt[] = [];
  try {
    attempts = JSON.parse(t.attempts_json || "[]");
  } catch {
    attempts = [];
  }
  attempts.push(attempt);
  // حد أقصى وقائي لسجل المحاولات حتى لا ينمو بلا حدود
  if (attempts.length > 100) attempts = attempts.slice(-100);
  await db().execute({
    sql: "UPDATE tasks SET attempts_json = ?, updated_at = ? WHERE id = ?",
    args: [JSON.stringify(attempts), nowIso(), id],
  });
}

export async function listRecentTasks(
  limit = 20,
  filters?: { type?: TaskRow["type"]; status?: TaskRow["status"] }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: unknown[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY created_at DESC LIMIT ?`;
  args.push(Math.min(Math.max(limit, 1), 50));
  const r = await db().execute({ sql, args: args as never });
  return r.rows.map((row) => rowToTask(row as unknown as Record<string, unknown>));
}

export interface TaskStats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export async function taskStats(): Promise<TaskStats> {
  await ensureSchema();
  const r = await db().execute(
    `SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`
  );
  const stats: TaskStats = { total: 0, completed: 0, failed: 0, processing: 0 };
  for (const row of r.rows) {
    const o = row as unknown as Record<string, unknown>;
    const c = asNum(o.c);
    stats.total += c;
    if (o.status === "completed") stats.completed = c;
    else if (o.status === "failed") stats.failed = c;
    else if (o.status === "processing" || o.status === "pending") stats.processing += c;
  }
  return stats;
}

export async function deleteTasksByIds(ids: string[]): Promise<void> {
  await ensureSchema();
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  await db().execute({ sql: `DELETE FROM tasks WHERE id IN (${ph})`, args: ids as never });
}

// استخراج روابط النتائج من صف المهمة
export function taskUrls(t: TaskRow): string[] {
  try {
    const arr = JSON.parse(t.result_urls_json || "[]");
    return Array.isArray(arr) ? arr.filter((u) => typeof u === "string") : [];
  } catch {
    return [];
  }
}

export function taskAttempts(t: TaskRow): TaskAttempt[] {
  try {
    const arr = JSON.parse(t.attempts_json || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
