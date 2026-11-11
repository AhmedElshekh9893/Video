// طبقة قاعدة البيانات: عميل Turso (libSQL) عبر HTTP — متوافق تمامًا مع Vercel Serverless
// لا توجد أي ملفات SQLite محلية؛ كل شيء عبر الشبكة
import { createClient, type Client, type InValue } from "@libsql/client";

let _client: Client | null = null;

export function db(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

// إنشاء كل الجداول عند أول وصول (CREATE TABLE IF NOT EXISTS) — لا حاجة لأداة migrations.
// نخزّن الوعد على مستوى العملية حتى لا يُنفَّذ أكثر من مرة.
const g = globalThis as unknown as { __mgSchemaPromise?: Promise<void> };

export function ensureSchema(): Promise<void> {
  if (!g.__mgSchemaPromise) {
    g.__mgSchemaPromise = (async () => {
      await db().executeMultiple(`
        -- مهام التوليد والدمج (task_id الذي يراه عميل MCP)
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );

        -- مفاتيح المزودين — تُجرَّب تسلسليًا حسب ترتيب الإضافة
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL
        );

        -- جدول خدمة الدمج الداخلية (Video Merger API v2)
        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'queued',
          progress INTEGER DEFAULT 0,
          error TEXT,
          video_size INTEGER,
          duration REAL,
          resolution TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sources (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          kind TEXT NOT NULL,
          url TEXT,
          name TEXT,
          size INTEGER,
          mime TEXT,
          uploaded_bytes INTEGER DEFAULT 0,
          PRIMARY KEY (job_id, seq)
        );

        CREATE TABLE IF NOT EXISTS source_chunks (
          job_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, seq, chunk)
        );

        CREATE TABLE IF NOT EXISTS output_chunks (
          job_id TEXT NOT NULL,
          chunk INTEGER NOT NULL,
          data BLOB NOT NULL,
          PRIMARY KEY (job_id, chunk)
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks (created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_expires ON jobs (expires_at);
      `);
    })().catch((e) => {
      g.__mgSchemaPromise = undefined; // اسمح بإعادة المحاولة عند الفشل
      throw e;
    });
  }
  return g.__mgSchemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    const r = await db().execute("SELECT 1 AS ok");
    return r.rows.length > 0;
  } catch {
    return false;
  }
}

// SQLite يرجع الأعداد الصحيحة أحيانًا كـ BigInt — وحّدناها إلى number
export function asNum(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return Number(v ?? 0);
}

// كل الطوابع الزمنية تُكتب من JavaScript بصيغة ISO لإ avoid مشاكل مقارنة الصيغ في SQL
export function nowIso(): string {
  return new Date().toISOString();
}

export type SqlArgs = InValue[];
