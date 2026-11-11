// فحص سريع للبيئة: اتصال Turso + صلاحية مفتاح kie.ai + أسماء الموديلات
import { createClient } from "@libsql/client";

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const KIE_KEY = process.env.KIE_API_KEY;

async function checkTurso() {
  const db = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });
  const r = await db.execute("SELECT 1 AS one");
  console.log("TURSO_OK", r.rows[0].one === 1n || r.rows[0].one === 1);
  const t = await db.execute("SELECT name FROM sqlite_master WHERE type='table'");
  console.log("TABLES:", t.rows.map((x) => x.name).join(", ") || "(فارغة)");
}

async function checkKie() {
  // 1) رصيد الحساب (نقطة رخيصة تؤكد صلاحية المفتاح)
  const c = await fetch("https://api.kie.ai/api/v1/chat/credit", {
    headers: { Authorization: `Bearer ${KIE_KEY}` },
  });
  const cj = await c.json().catch(() => ({}));
  console.log("KIE_CREDIT", c.status, JSON.stringify(cj));

  // 2) إنشاء مهمة صورة حقيقية صغيرة للتأكد من اسم الموديل وشكل الطلب
  const res = await fetch("https://api.kie.ai/api/v1/jobs/createTask", {
    method: "POST",
    headers: { Authorization: `Bearer ${KIE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-image-2-6/flare-text-to-image",
      input: { prompt: "a tiny red apple on a white background, minimal", aspect_ratio: "1:1" },
    }),
  });
  const j = await res.json().catch(() => ({}));
  console.log("KIE_IMAGE_CREATE", res.status, JSON.stringify(j).slice(0, 500));
  if (j?.data?.taskId) {
    // استطلاع قصير حتى 90 ثانية
    for (let i = 0; i < 30; i++) {
      await new Promise((s) => setTimeout(s, 3000));
      const q = await fetch(
        `https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(j.data.taskId)}`,
        { headers: { Authorization: `Bearer ${KIE_KEY}` } }
      );
      const qj = await q.json().catch(() => ({}));
      const st = qj?.data?.state;
      console.log("KIE_POLL", i, st, String(qj?.data?.resultJson || qj?.data?.failMsg || "").slice(0, 300));
      if (st === "success" || st === "fail") break;
    }
  }
}

checkTurso().catch((e) => console.error("TURSO_FAIL", String(e).slice(0, 300)));
checkKie().catch((e) => console.error("KIE_FAIL", String(e).slice(0, 300)));
