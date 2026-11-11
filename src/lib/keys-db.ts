// عمليات جدول المفاتيح — CRUD + عدّادات الاستخدام
import { db, ensureSchema, nowIso, asNum } from "./turso";
import { randomUUID } from "crypto";

export type KeyProvider = "kie" | "cometapi";

export interface ApiKeyRow {
  id: string;
  provider: KeyProvider;
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function rowToKey(r: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(r.id),
    provider: r.provider as KeyProvider,
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: (r.status ?? "active") as ApiKeyRow["status"],
    usage_count: asNum(r.usage_count),
    success_count: asNum(r.success_count),
    fail_count: asNum(r.fail_count),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at),
  };
}

export async function listKeys(): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const r = await db().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return r.rows.map((row) => rowToKey(row as unknown as Record<string, unknown>));
}

export async function getKeyById(id: string): Promise<ApiKeyRow | null> {
  await ensureSchema();
  const r = await db().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  if (!r.rows.length) return null;
  return rowToKey(r.rows[0] as unknown as Record<string, unknown>);
}

export async function findDuplicate(provider: string, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return r.rows.length > 0;
}

export async function createKey(provider: KeyProvider, apiKey: string, label: string): Promise<ApiKeyRow> {
  await ensureSchema();
  const id = randomUUID();
  const now = nowIso();
  await db().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status, created_at)
          VALUES (?, ?, ?, ?, 'active', ?)`,
    args: [id, provider, label, apiKey, now],
  });
  return (await getKeyById(id))!;
}

export async function setKeyStatus(id: string, status: ApiKeyRow["status"], lastError?: string): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `UPDATE api_keys SET status = ?, last_checked_at = ?, last_error = COALESCE(?, last_error) WHERE id = ?`,
    args: [status, nowIso(), lastError ?? null, id],
  });
}

export async function deleteKey(id: string): Promise<void> {
  await ensureSchema();
  await db().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

// تحديث عدّادات المفتاح بعد كل محاولة (نجاح أو فشل)
export async function bumpKeyUsage(id: string, ok: boolean, error?: string): Promise<void> {
  await ensureSchema();
  const now = nowIso();
  await db().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ${ok ? 1 : 0},
            fail_count = fail_count + ${ok ? 0 : 1},
            last_used_at = ?, last_checked_at = ?,
            last_error = ${ok ? "last_error" : "?"}
          WHERE id = ?`,
    args: ok ? [now, now, id] : [now, now, (error ?? "").slice(0, 500), id],
  });
}
