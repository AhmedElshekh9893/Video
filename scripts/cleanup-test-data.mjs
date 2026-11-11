// تنظيف آثار الاختبار: حذف كل مهام التوليد والمهام الدمج والمفتاح الخاطئ من قاعدة البيانات
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const jobs = await db.execute("SELECT id FROM jobs");
for (const r of jobs.rows) {
  const id = String(r.id);
  await db.batch(
    [
      { sql: "DELETE FROM source_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM output_chunks WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM sources WHERE job_id = ?", args: [id] },
      { sql: "DELETE FROM jobs WHERE id = ?", args: [id] },
    ],
    "write"
  );
  console.log("deleted job:", id);
}

const t = await db.execute("DELETE FROM tasks");
console.log("deleted tasks rowsAffected:", t.rowsAffected);

const k = await db.execute("DELETE FROM api_keys WHERE label LIKE '%اختبار%' OR api_key LIKE 'FAKE%'");
console.log("deleted fake keys rowsAffected:", k.rowsAffected);

const left = await db.execute("SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM jobs) AS jobs, (SELECT COUNT(*) FROM api_keys) AS keys");
console.log("remaining:", JSON.stringify(left.rows[0]));
