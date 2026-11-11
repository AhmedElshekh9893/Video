// التنظيف التلقائي: كل مهمة دمج تُحذف بالكامل بعد انتهاء صلاحيتها (24 ساعة)
// - تنظيف كسول عند كل طلب إنشاء/دمج
// - نقطة /api/cron مجدولة يوميًا في vercel.json
import { db, ensureSchema, nowIso } from "../turso";
import * as store from "./store";
import { MERGE_LIMITS } from "../config";

export async function deleteExpiredJobs(): Promise<number> {
  await ensureSchema();
  const r = await db().execute({
    sql: "SELECT id FROM jobs WHERE expires_at < ?",
    args: [nowIso()],
  });
  const ids = r.rows.map((row) => String((row as unknown as Record<string, unknown>).id));
  for (const id of ids) {
    await store.deleteJobCascade(id);
  }
  return ids.length;
}

export async function lazyCleanup(): Promise<void> {
  try {
    await deleteExpiredJobs();
  } catch {
    // التنظيف غير حرج — لا يفشل الطلب الحالي
  }
}

export function expiryIso(): string {
  return new Date(Date.now() + MERGE_LIMITS.retentionHours * 3600 * 1000).toISOString();
}
