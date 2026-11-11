// نظام المفاتيح المتسلسلة (قلب المشروع):
// - ترتيب صارم حسب ترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin
// - تصنيف موحد لأخطاء المزودين يقود سلوك التبديل
// - إخفاء إلزامي للمفاتيح في كل الاستجابات
import { db, ensureSchema } from "./turso";
import type { ApiKeyRow } from "./keys-db";

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

export class ProviderError extends Error {
  constructor(public status: number | undefined, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof ProviderError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function errStatus(e: unknown): number | undefined {
  return e instanceof ProviderError ? e.status : undefined;
}

/**
 * تصنيف خطأ المزود (يُفحص استنزاف الرصيد قبل 400 لأن بعض المزودين
 * يرسلون نفاد الرصيد بحالة 400):
 * - disabled  : مفتاح مرفوض → يُعلَّم disabled تلقائيًا → المفتاح التالي
 * - exhausted : نفاد رصيد → يُعلَّم exhausted (يبقى في القاعدة) → التالي
 * - provider  : الموديل غير مدعوم لدى هذا المزود → التالي
 * - params    : خطأ في معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحلها)
 * - temporary : 429 / 5xx / شبكة / مهلة → التالي الآن
 */
export function classifyProviderError(status: number | undefined, message: string): ErrorClass {
  const m = (message || "").toLowerCase();
  if (
    status === 402 ||
    /insufficient|quota|balance|credit|out of credits|exhausted|充值/.test(m)
  ) {
    return "exhausted";
  }
  if (status === 401 || status === 403 || /invalid api key|unauthorized|forbidden|authentication/.test(m)) {
    return "disabled";
  }
  if ((status === 400 || status === 404 || status === 422) && /model not found|unsupported model|model does not exist|no such model|unknown model/.test(m)) {
    return "provider";
  }
  if (status === 400 || status === 422) return "params";
  return "temporary"; // 429، 5xx، انقطاع شبكة، مهلة، abort
}

export function classify(e: unknown): ErrorClass {
  return classifyProviderError(errStatus(e), errMsg(e));
}

// جلب المرشحين بالترتيب التسلسلي الصارم: أول مفتاح أُضيف يُجرَّب أولًا.
// المفتاح المستنزف (exhausted) يبقى في القائمة — الاستثناء الوحيد للتعطيل اليدوي (disabled).
export async function getKeyPool(providers: string[]): Promise<ApiKeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(",");
  const r = await db().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return r.rows.map((row) => row as unknown as ApiKeyRow);
}

// إخفاء المفتاح إلزاميًا في كل الاستجابات والسجلات — لا يُعاد المفتاح الكامل أبدًا
export function maskKey(k: string): string {
  if (k.length <= 8) return k.slice(0, 3) + "••••";
  return k.slice(0, 7) + "••••••••" + k.slice(-4);
}
