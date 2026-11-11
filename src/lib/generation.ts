// منسّق التوليد runGeneration / refreshTask — منطق التبديل التسلسلي «لا توقف أبدًا»:
// 1. تجربة المفاتيح بالترتيب الصارم حتى نجاح الإنشاء.
// 2. أي فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء نفس المهمة بنفس task_id على المفتاح التالي.
// 3. فشل على كل المفاتيح → تبقى processing وتُعاد المحاولة مع كل get_task (تهدئة ~45 ثانية).
// 4. نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا.
import { randomUUID } from "crypto";
import { ProviderError, classify, errMsg, errStatus, getKeyPool } from "./keys";
import { getAdapter, createImageSync } from "./providers";
import type { GenInput } from "./providers/types";
import type { ModelDef } from "./models";
import { resolveModel, defaultModelFor } from "./models";
import * as tasks from "./tasks-db";
import type { TaskRow } from "./tasks-db";
import * as keysDb from "./keys-db";
import type { ApiKeyRow } from "./keys-db";

// أنماط رسائل مشكلات المفتاح/الرصيد — أي فشل يطابقها يستأنف على مفتاح آخر
const KEY_FAIL_RE =
  /insufficient|balance|credit|quota|exhausted|充值|invalid api key|unauthorized|forbidden|authentication|402|401|invalid.?key/i;

// تنظيف الرسائل الخارجة للعميل: لا ذكر لأي مفتاح أو رصيد أبدًا
export function sanitizeUserMessage(msg: string): string {
  return KEY_FAIL_RE.test(msg || "") ? "حدث خطأ مؤقت لدى مزود التوليد" : msg || "خطأ غير معروف";
}

export interface ProgressNotifier {
  sendProgress(progress: number, total: number, message: string): Promise<void>;
}

interface CreateOutcome {
  ok: boolean;
  provider?: string;
  keyId?: string;
  providerTaskId?: string;
  urls?: string[]; // للصور المتزامنة فقط
  paramsError?: string;
}

export interface ToolReply {
  text: string;
  isError?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampWait(v: unknown, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(240, Math.max(0, Math.round(n)));
}

async function notify(notifier: ProgressNotifier | null, progress: number, message: string): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.sendProgress(progress, 100, message);
  } catch {
    // إشعارات التقدم اختيارية — لا تفشل المهمة بسببها
  }
}

// ─── المرحلة 1: إنشاء المهمة لدى المزود بتجربة كل المفاتيح بالترتيب ───
async function tryCreateOnPool(
  taskId: string,
  model: ModelDef,
  input: GenInput
): Promise<CreateOutcome> {
  const pool = await getKeyPool(model.providers);
  for (const key of pool) {
    const providerModel = model.providerModel[key.provider as keyof typeof model.providerModel];
    try {
      let handle: { providerTaskId: string } | { urls: string[] };
      if (model.type === "image" && key.provider !== "kie") {
        // صور متزامنة لدى CometAPI — النتيجة فورًا
        handle = await createImageSync(key.provider, key, providerModel, input);
      } else {
        handle = await getAdapter(key.provider).createTask(key, providerModel, input);
      }
      await tasks.appendAttempt(taskId, {
        provider: key.provider, keyId: key.id, keyLabel: key.label, ok: true, at: new Date().toISOString(),
      });
      await keysDb.bumpKeyUsage(key.id, true);
      if ("urls" in handle) return { ok: true, provider: key.provider, keyId: key.id, urls: handle.urls };
      return { ok: true, provider: key.provider, keyId: key.id, providerTaskId: handle.providerTaskId };
    } catch (e) {
      const cls = classify(e);
      const msg = errMsg(e).slice(0, 300);
      await tasks.appendAttempt(taskId, {
        provider: key.provider, keyId: key.id, keyLabel: key.label,
        ok: false, errorClass: cls, error: msg, at: new Date().toISOString(),
      });
      await keysDb.bumpKeyUsage(key.id, false, msg);
      if (cls === "disabled") await keysDb.setKeyStatus(key.id, "disabled", msg);
      else if (cls === "exhausted") await keysDb.setKeyStatus(key.id, "exhausted", msg);
      if (cls === "params") {
        // خطأ معطيات — تبديل المفاتيح لن يحلّه: توقف فورًا
        return { ok: false, paramsError: msg };
      }
      // disabled / exhausted / provider / temporary → جرّب المفتاح التالي فورًا
    }
  }
  return { ok: false };
}

// ─── المرحلة 2: استطلاع واحد للمهمة مع قواعد التبديل كاملة ───
// يُستخدم داخل نافذة الانتظار وكذلك مع كل استدعاء get_task
async function pollOnce(
  task: TaskRow,
  model: ModelDef,
  input: GenInput,
  notifier: ProgressNotifier | null,
  opts: { allowCreateRetry: boolean; recreateBudget: { n: number } }
): Promise<{ kind: "completed" | "failed" | "processing"; error?: string; progress?: number }> {
  const urlsOf = (t: TaskRow) => tasks.taskUrls(t);

  // لا يوجد provider_task_id: الإنشاء فشل سابقًا على كل المفاتيح — أعد المحاولة بعد تهدئة 45 ثانية
  if (!task.provider_task_id || !task.provider) {
    if (!opts.allowCreateRetry) return { kind: "processing" };
    if (Date.now() - Date.parse(task.updated_at) < 45_000) return { kind: "processing" };
    const again = await tryCreateOnPool(task.id, model, input);
    if (!again.ok) {
      await tasks.updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
      return { kind: "processing" };
    }
    if (again.urls) {
      // صورة متزامنة اكتملت فورًا
      await tasks.updateTask(task.id, {
        provider: again.provider, key_id: again.keyId, status: "completed", progress: 100,
        result_urls_json: JSON.stringify(again.urls),
      });
      return { kind: "completed" };
    }
    await tasks.updateTask(task.id, {
      provider: again.provider, key_id: again.keyId, provider_task_id: again.providerTaskId,
      status: "processing", error_message: null,
    });
    task.provider = again.provider!;
    task.provider_task_id = again.providerTaskId!;
    task.key_id = again.keyId!;
    return { kind: "processing", progress: 5 };
  }

  const adapter = getAdapter(task.provider);
  let key: ApiKeyRow | null = await keysDb.getKeyById(task.key_id ?? "");

  // استطلاع الحالة من المزود
  let check;
  try {
    if (!key || key.status === "disabled") {
      // المفتاح حُذف أو عُطّل أثناء المهمة → أعد الإنشاء على المفاتيح المتبقية
      throw new ProviderError(403, "invalid api key (key removed)");
    }
    check = await adapter.checkTask(key, task.provider_task_id);
  } catch (e) {
    const cls = classify(e);
    if (cls === "temporary" && !(e instanceof ProviderError && /key removed/.test(errMsg(e)))) {
      // خطأ شبكة/ضغط مؤقت أثناء الاستطلاع فقط — لا يفسد المهمة
      return { kind: "processing" };
    }
    // مفتاح/رصيد/تعطيل أثناء الاستطلاع → إعادة إنشاء بنفس task_id على المفتاح التالي
    if (!opts.allowCreateRetry || opts.recreateBudget.n <= 0) return { kind: "processing" };
    opts.recreateBudget.n--;
    await tasks.appendAttempt(task.id, {
      provider: task.provider, keyId: task.key_id ?? undefined,
      ok: false, errorClass: "mid-task-switch", error: errMsg(e).slice(0, 300), at: new Date().toISOString(),
    });
    const again = await tryCreateOnPool(task.id, model, input);
    if (!again.ok) {
      await tasks.updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
      return { kind: "processing" };
    }
    if (again.urls) {
      await tasks.updateTask(task.id, {
        provider: again.provider, key_id: again.keyId, status: "completed", progress: 100,
        result_urls_json: JSON.stringify(again.urls),
      });
      return { kind: "completed" };
    }
    await tasks.updateTask(task.id, {
      provider: again.provider, key_id: again.keyId, provider_task_id: again.providerTaskId,
      status: "processing", error_message: null,
    });
    task.provider = again.provider!;
    task.provider_task_id = again.providerTaskId!;
    task.key_id = again.keyId!;
    return { kind: "processing", progress: 5 };
  }

  if (check.status === "completed" && check.urls?.length) {
    await tasks.updateTask(task.id, {
      status: "completed", progress: 100, result_urls_json: JSON.stringify(check.urls), error_message: null,
    });
    return { kind: "completed" };
  }

  if (check.status === "failed") {
    const raw = check.error ?? "فشل غير معروف";
    if (KEY_FAIL_RE.test(raw)) {
      // فشل مفتاح/رصيد في منتصف المهمة → استئناف صامت على المفتاح التالي
      if (!opts.allowCreateRetry || opts.recreateBudget.n <= 0) return { kind: "processing" };
      opts.recreateBudget.n--;
      const again = await tryCreateOnPool(task.id, model, input);
      if (!again.ok) {
        await tasks.updateTask(task.id, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
        return { kind: "processing" };
      }
      if (again.urls) {
        await tasks.updateTask(task.id, {
          provider: again.provider, key_id: again.keyId, status: "completed", progress: 100,
          result_urls_json: JSON.stringify(again.urls),
        });
        return { kind: "completed" };
      }
      await tasks.updateTask(task.id, {
        provider: again.provider, key_id: again.keyId, provider_task_id: again.providerTaskId,
        status: "processing", error_message: null,
      });
      task.provider = again.provider!;
      task.provider_task_id = again.providerTaskId!;
      task.key_id = again.keyId!;
      return { kind: "processing", progress: 5 };
    }
    // فشل حقيقي (معطيات/سياسة…) — رسالة نظيفة بلا أي ذكر لمفاتيح
    const clean = sanitizeUserMessage(raw);
    await tasks.updateTask(task.id, { status: "failed", error_message: clean });
    return { kind: "failed", error: clean };
  }

  // processing — تقدم أحادي الاتجاه لا يتراجع
  const est = Math.max(task.progress, Math.min(95, check.progress ?? 0));
  await tasks.updateTask(task.id, { progress: est });
  await notify(
    notifier,
    est,
    task.type === "image" ? `قيد التوليد… ${est}%` : `قيد التوليد… ${est}%`
  );
  return { kind: "processing", progress: est };
}

// ─── الرسائل العربية الجاهزة للعرض (مواصفة §8) ───
export function processingMessage(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

function linksBlock(urls: string[]): string {
  return urls.map((u, i) => (urls.length > 1 ? `${i + 1}. ${u}` : u)).join("\n");
}

export function completedMessage(task: TaskRow): string {
  const urls = tasks.taskUrls(task);
  if (task.type === "image") {
    const img = urls[0] ?? "";
    return `✅ تم توليد الصورة بنجاح\n\n![image](${img})\n\nالرابط المباشر: ${img}`;
  }
  if (task.type === "video") {
    return `✅ تم توليد الفيديو بنجاح\n\n${linksBlock(urls)}`;
  }
  // merge
  return `✅ تم دمج المقاطع بنجاح\n\n${linksBlock(urls)}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

function failedMessage(reason: string): ToolReply {
  return { text: `❌ فشلت المهمة: ${reason}`, isError: true };
}

// ─── الأداة: generate_image / generate_video ───
export async function runGeneration(
  type: "image" | "video",
  args: Record<string, unknown>,
  notifier: ProgressNotifier | null
): Promise<ToolReply> {
  const model = resolveModel((args.model as string) || defaultModelFor(type));
  if (!model || model.type !== type) {
    return { text: `❌ موديل غير معروف: ${args.model}. المتاح: ${defaultModelFor(type)}`, isError: true };
  }

  // فارغ → رد فوري بلا تسجيل مهمة (حسب ترتيب §6)
  const pool = await getKeyPool(model.providers);
  if (!pool.length) {
    return {
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${model.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    };
  }

  const input: GenInput = {
    prompt: String(args.prompt ?? ""),
    imageUrl: (args.image_url as string) || undefined,
    aspectRatio: (args.aspect_ratio as string) || undefined,
    resolution: (args.resolution as string) || undefined,
    background: (args.background as string) || undefined,
    outputFormat: (args.output_format as string) || undefined,
    enableAudio: typeof args.enable_audio === "boolean" ? (args.enable_audio as boolean) : undefined,
    duration: typeof args.duration === "number" ? (args.duration as number) : undefined,
  };

  // سجّل المهمة في Turso قبل أي نداء خارجي — تبقى قابلة للتتبع حتى لو انقطع الاتصال
  const taskId = randomUUID();
  await tasks.insertTask({
    id: taskId, model: model.canonical, type, prompt: input.prompt,
    params_json: JSON.stringify(args), status: "processing",
  });

  const created = await tryCreateOnPool(taskId, model, input);

  if (!created.ok) {
    if (created.paramsError) {
      const clean = sanitizeUserMessage(created.paramsError);
      await tasks.updateTask(taskId, { status: "failed", error_message: clean });
      return failedMessage(clean);
    }
    // فشل الإنشاء على كل المفاتيح → تبقى processing وتُعاد محاولتها مع كل get_task
    await tasks.updateTask(taskId, { status: "processing", error_message: "بانتظار توفر مفتاح صالح…" });
    return { text: processingMessage(taskId) };
  }

  if (created.urls) {
    // صورة متزامنة اكتملت فورًا
    await tasks.updateTask(taskId, {
      provider: created.provider, key_id: created.keyId, status: "completed", progress: 100,
      result_urls_json: JSON.stringify(created.urls),
    });
    const t = await tasks.getTask(taskId);
    return { text: completedMessage(t!) };
  }

  await tasks.updateTask(taskId, {
    provider: created.provider, key_id: created.keyId, provider_task_id: created.providerTaskId,
    status: "processing", error_message: null,
  });

  // نافذة الانتظار: استطلاع كل 3 ثوانٍ مع بث تقدم حي
  const dfltWait = type === "image" ? 90 : 25;
  const waitSec = clampWait(args.wait_seconds, dfltWait);
  const deadline = Date.now() + waitSec * 1000;
  const budget = { n: 4 }; // أقصى عدد إعادة إنشاء داخل النافذة (تبديل مفاتيح متكرر)
  let task = await tasks.getTask(taskId);

  while (Date.now() < deadline) {
    await sleep(3000);
    task = await tasks.getTask(taskId);
    if (!task) break;
    const r = await pollOnce(task, model, input, notifier, { allowCreateRetry: true, recreateBudget: budget });
    if (r.kind === "completed") {
      const t2 = await tasks.getTask(taskId);
      return { text: completedMessage(t2!) };
    }
    if (r.kind === "failed") return failedMessage(r.error ?? "خطأ غير معروف");
  }

  // انتهت النافذة والنتيجة لم تظهر → أعد task_id والعميل يتابع بـ get_task
  return { text: processingMessage(taskId) };
}

// ─── الأداة: get_task — تحديث حي من المزود مع نفس منطق التبديل ───
export async function refreshTask(taskId: string, notifier: ProgressNotifier | null = null): Promise<ToolReply> {
  const task = await tasks.getTask(taskId);
  if (!task) {
    return { text: `❌ لا توجد مهمة بهذا المعرّف: ${taskId}. تحقق من task_id أو استخدم list_media لعرض المهام المخزنة.`, isError: true };
  }

  if (task.type === "merge") {
    // مهمة دمج — منطقها في merge.ts (يُستدعى من هناك لتفادي الاستيراد الدائري)
    const { refreshMergeTask } = await import("./merge");
    return refreshMergeTask(task);
  }

  if (task.status === "completed") return { text: completedMessage(task) };
  if (task.status === "failed") return failedMessage(sanitizeUserMessage(task.error_message ?? ""));

  const model = resolveModel(task.model);
  if (!model) return failedMessage("موديل المهمة غير معروف");

  let input: GenInput;
  try {
    const p = JSON.parse(task.params_json || "{}");
    input = {
      prompt: String(p.prompt ?? task.prompt ?? ""),
      imageUrl: p.image_url || undefined,
      aspectRatio: p.aspect_ratio || undefined,
      resolution: p.resolution || undefined,
      background: p.background || undefined,
      outputFormat: p.output_format || undefined,
      enableAudio: typeof p.enable_audio === "boolean" ? p.enable_audio : undefined,
      duration: typeof p.duration === "number" ? p.duration : undefined,
    };
  } catch {
    input = { prompt: task.prompt };
  }

  const r = await pollOnce(task, model, input, notifier, { allowCreateRetry: true, recreateBudget: { n: 4 } });
  if (r.kind === "completed") {
    const t2 = await tasks.getTask(taskId);
    return { text: completedMessage(t2!) };
  }
  if (r.kind === "failed") return failedMessage(r.error ?? "خطأ غير معروف");
  return { text: processingMessage(taskId) };
}

// ─── الأداة: list_media — استرجاع الوسائط المخزنة بروابطها ───
export async function listMedia(args: Record<string, unknown>): Promise<ToolReply> {
  const type = args.type as TaskRow["type"] | undefined;
  const status = args.status as TaskRow["status"] | undefined;
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  const rows = await tasks.listRecentTasks(limit, { type, status });
  if (!rows.length) return { text: "لا توجد مهام مخزنة بعد بهذه الفلاتر — ولّد وسائط جديدة أولًا بـ generate_image أو generate_video." };
  const lines = rows.map((t) => {
    const urls = tasks.taskUrls(t);
    const icon = t.type === "image" ? "🖼️" : t.type === "video" ? "🎬" : "🎞️";
    const when = (t.completed_at ?? t.created_at).replace("T", " ").slice(0, 16);
    if (t.status === "completed" && urls.length) {
      return `${icon} [${t.id.slice(0, 8)}] ${t.type} — ${t.model} — ${when}\n   ${linksBlock(urls)}`;
    }
    if (t.status === "failed") {
      return `${icon} [${t.id.slice(0, 8)}] ${t.type} — فاشلة (${sanitizeUserMessage(t.error_message ?? "")}) — ${when}`;
    }
    return `${icon} [${t.id.slice(0, 8)}] ${t.type} — ${t.status} (${t.progress}%) — ${when} — تابعها بـ get_task`;
  });
  return { text: `أحدث الوسائط المخزنة (${rows.length}):\n\n${lines.join("\n\n")}` };
}
