// أداة merge_videos: دمج عدة مقاطع في فيديو واحد بالترتيب المعطى
// قواعد حتمية (§7.3): ≥2 و≤10 مقاطع، أخطاء الخدمة المعلنة = فشل نهائي فوري،
// أخطاء شبكتنا = مؤقتة وتستمر بالاستعلام، والملف الناتج يعيش ~24 ساعة فقط.
import { randomUUID } from "crypto";
import { after } from "next/server";
import * as tasks from "./tasks-db";
import type { TaskRow } from "./tasks-db";
import { getMergerService } from "./merger-service";
import type { MergerJobStatus } from "./merger-service";
import { JobNotFoundError } from "./merger/runner";
import { MERGE_LIMITS } from "./config";
import type { ProgressNotifier, ToolReply } from "./generation";
import { processingMessage } from "./generation";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// الرابط المطلق للتطبيق عندما لا تتوفر ترويسات الطلب (سياق MCP)
export function selfOrigin(): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (prod) return `https://${prod}`;
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

async function finishMergeTask(taskId: string, jobId: string, s: MergerJobStatus): Promise<void> {
  const url = s.videoUrl || s.downloadUrl || `${selfOrigin()}/api/jobs/${jobId}/video`;
  await tasks.updateTask(taskId, {
    status: "completed", progress: 100, error_message: null,
    result_urls_json: JSON.stringify([url]),
  });
}

export function mergeCompletedMessage(s: MergerJobStatus): string {
  const url = s.videoUrl || s.downloadUrl || "";
  return (
    `✅ تم دمج المقاطع بنجاح\n\n${url}\n\n` +
    (s.size ? `الحجم: ${(s.size / 1024 / 1024).toFixed(1)}MB — المدة: ${Math.round(s.duration ?? 0)} ثانية — الدقة: ${s.resolution ?? "?"}\n\n` : "") +
    `⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`
  );
}

export async function runMerge(args: Record<string, unknown>, notifier: ProgressNotifier | null): Promise<ToolReply> {
  const urls: string[] = [];
  const failures: string[] = [];

  // 1) حل روابط task_ids أولًا (مهام فيديو مكتملة) بالترتيب
  const taskIds = Array.isArray(args.task_ids) ? (args.task_ids as string[]) : [];
  for (const tid of taskIds) {
    const t = await tasks.getTask(String(tid));
    const u = t && t.status === "completed" ? tasks.taskUrls(t) : [];
    if (!u.length) {
      failures.push(`— ${tid}: ليست مهمة مكتملة أو بلا روابط نتائج`);
      continue;
    }
    urls.push(u[0]);
  }

  // 2) ثم الروابط المباشرة بنفس ترتيبها
  const direct = Array.isArray(args.urls) ? (args.urls as string[]) : [];
  for (const u of direct) urls.push(String(u));

  if (urls.length < 2) {
    let text = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (failures.length) text += `\n\nتفاصيل المعرّفات غير المكتملة:\n${failures.join("\n")}`;
    return { text, isError: true };
  }
  if (urls.length > MERGE_LIMITS.maxSources) {
    return { text: `❌ أقصى عدد مقاطع للدمج هو ${MERGE_LIMITS.maxSources} (خدمة الدمج تقبل ${MERGE_LIMITS.maxSources} مقاطع كحد أقصى).`, isError: true };
  }
  const bad = urls.find((u) => !/^https?:\/\//i.test(u));
  if (bad) {
    return { text: `❌ جميع الروابط يجب أن تكون روابط مباشرة عامة (http/https). رابط غير صالح: ${bad}`, isError: true };
  }

  // 3) سجّل مهمة الدمج في Turso أولًا
  const taskId = randomUUID();
  await tasks.insertTask({
    id: taskId, provider: "merger", model: "video-merger", type: "merge",
    prompt: `دمج ${urls.length} مقاطع`, params_json: JSON.stringify({ urls }), status: "processing",
  });

  // 4) إنشاء مهمة لدى خدمة الدمج
  const svc = getMergerService();
  let job;
  try {
    job = await svc.createJob(urls);
  } catch (e) {
    const msg = (e as Error).message ?? "فشل إنشاء مهمة الدمج";
    await tasks.updateTask(taskId, { status: "failed", error_message: msg });
    return { text: `❌ فشلت المهمة: ${msg}`, isError: true };
  }
  await tasks.updateTask(taskId, { provider_task_id: job.jobId, status: "processing" });

  // 5) أطلق المعالجة مرة واحدة فقط وسبّقها مع نافذة الانتظار مع بث التقدم
  const waitSec = Math.min(240, Math.max(0, Number(args.wait_seconds) || 60));
  const deadline = Date.now() + waitSec * 1000;

  const persist = async (s: MergerJobStatus): Promise<MergerJobStatus> => {
    if (s.status === "done") await finishMergeTask(taskId, job.jobId, s);
    else if (s.status === "failed") {
      await tasks.updateTask(taskId, { status: "failed", error_message: s.error ?? "فشلت خدمة الدمج" });
    }
    return s;
  };

  let settled = false;
  const procP = svc
    .startProcess(job.jobId, selfOrigin())
    .then(persist)
    .then((s) => { settled = true; return s; })
    .catch((e) => {
      settled = true;
      return persist({ status: "failed", progress: 100, error: (e as Error).message });
    });

  while (Date.now() < deadline) {
    const winner = await Promise.race([
      procP.then((s) => ({ t: "proc" as const, s })),
      sleep(3000).then(() => ({ t: "tick" as const })),
    ]);
    if (winner.t === "proc") {
      const s = winner.s;
      if (s.status === "done") return { text: mergeCompletedMessage(s) };
      if (s.status === "failed") return { text: `❌ فشلت المهمة: ${s.error ?? "فشلت خدمة الدمج"}`, isError: true };
      break; // مشغولة — تابع الاستعلام
    }
    try {
      const j = await svc.getJob(job.jobId, selfOrigin());
      if (j.status === "done") {
        await finishMergeTask(taskId, job.jobId, j);
        return { text: mergeCompletedMessage(j) };
      }
      if (j.status === "failed") {
        await tasks.updateTask(taskId, { status: "failed", error_message: j.error ?? "فشلت خدمة الدمج" });
        return { text: `❌ فشلت المهمة: ${j.error ?? "فشلت خدمة الدمج"}`, isError: true };
      }
      const pct = Math.max(0, Math.min(99, j.progress || 0));
      await tasks.updateTask(taskId, { progress: pct });
      await notifier?.sendProgress(pct, 100, `جارٍ دمج المقاطع… ${pct}%`);
    } catch (e) {
      if (e instanceof JobNotFoundError) {
        await tasks.updateTask(taskId, { status: "failed", error_message: (e as Error).message });
        return { text: `❌ فشلت المهمة: ${(e as Error).message}`, isError: true };
      }
      // أخطاء شبكتنا — استمر بالاستعلام حتى انتهاء النافذة
    }
  }

  // 6) انتهت النافذة — لا توقف المعالجة: اسمح لها بالإكمال بعد الرد ضمن نفس ميزانية الزمن،
  //    وسيُحدَّث حالة المهمة في القاعدة عند انتهائها (persist) ويراجعها get_task لاحقًا.
  if (!settled) {
    try {
      after(async () => {
        await procP;
      });
    } catch {
      // بعد() غير متاح خارج سياق الطلب — المهمة سيراكمها get_task
    }
  }
  return { text: processingMessage(taskId) };
}

// get_task لمهمة دمج — تحديث حي من خدمة الدمج مع إعادة تشغيل المعالجة عند الحاجة
export async function refreshMergeTask(task: TaskRow): Promise<ToolReply> {
  const svc = getMergerService();
  const jobId = task.provider_task_id ?? "";
  if (!jobId) return { text: processingMessage(task.id) };

  let j: MergerJobStatus;
  try {
    j = await svc.getJob(jobId, selfOrigin());
  } catch (e) {
    if (e instanceof JobNotFoundError) {
      await tasks.updateTask(task.id, { status: "failed", error_message: (e as Error).message });
      return { text: `❌ فشلت المهمة: ${(e as Error).message}`, isError: true };
    }
    return { text: processingMessage(task.id) }; // شبكة مؤقتة
  }

  if (j.status === "done") {
    await finishMergeTask(task.id, jobId, j);
    return { text: mergeCompletedMessage(j) };
  }
  if (j.status === "failed") {
    await tasks.updateTask(task.id, { status: "failed", error_message: j.error ?? "فشلت خدمة الدمج" });
    return { text: `❌ فشلت المهمة: ${j.error ?? "فشلت خدمة الدمج"}`, isError: true };
  }

  // مهمة لم تبدأ معالجتها بعد أو تعطّل مثيلها — نفّذ العملية الآن (الاستحواذ يمنع التزامن)
  const staleMs = 5 * 60 * 1000;
  const isStale = Date.now() - Date.parse(task.updated_at) > staleMs;
  if (j.status === "queued" || j.status === "uploading" || (j.status === "processing" && isStale)) {
    const procP = svc
      .startProcess(jobId, selfOrigin())
      .then(async (s) => {
        if (s.status === "done") await finishMergeTask(task.id, jobId, s);
        else if (s.status === "failed") await tasks.updateTask(task.id, { status: "failed", error_message: s.error });
      })
      .catch(() => {});
    try {
      after(async () => {
        await procP;
      });
    } catch {
      // خارج سياق الطلب
    }
  }
  return { text: processingMessage(task.id) };
}
