// مزود kie.ai — Jobs API الموحد (الشكل الحقيقي المقاس بنداءات فعلية):
// POST /api/v1/jobs/createTask  → {"code":200,"data":{"taskId":"..."}}
// GET  /api/v1/jobs/recordInfo?taskId= → {"code":200,"data":{"state":"waiting|queuing|generating|success|fail",
//        "resultJson":"{\"resultUrls\":[\"...\"]}",  ← نص JSON داخل JSON يحتاج JSON.parse ثانيًا
//        "failMsg":"..."}}
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenInput, ProviderCheckResult } from "./types";
import type { ApiKeyRow } from "../keys-db";

const KIE_JOBS = "https://api.kie.ai/api/v1/jobs";

async function kieFetch<T>(key: ApiKeyRow, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${KIE_JOBS}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    // انقطاع شبكتنا نحن → temporary وليس خطأ مفتاح
    throw new ProviderError(undefined, `network: ${(e as Error)?.message ?? e}`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const code = typeof body?.code === "number" ? body.code : undefined;
  if (!res.ok || (code !== undefined && code !== 200)) {
    const msg = String(body?.msg ?? body?.message ?? `HTTP ${res.status}`);
    throw new ProviderError(res.status, msg);
  }
  return body as T;
}

// بناء input لموديل الصورة — نمرّر فقط الحقول المعرفة (اختُبرت فعليًا وأُكِّد قبولها)
export function imageInput(a: GenInput): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: a.prompt };
  if (a.aspectRatio && a.aspectRatio !== "auto") input.aspect_ratio = a.aspectRatio;
  if (a.resolution) input.resolution = a.resolution;
  if (a.background && a.background !== "auto") input.background = a.background;
  if (a.outputFormat) input.output_format = a.outputFormat;
  return input;
}

// بناء input لموديل الفيديو (اختُبر فعليًا: aspect_ratio + duration مقبولان)
export function videoInput(a: GenInput): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: a.prompt };
  if (a.imageUrl) input.image_url = a.imageUrl;
  if (a.aspectRatio && a.aspectRatio !== "auto") input.aspect_ratio = a.aspectRatio;
  if (a.resolution) input.resolution = a.resolution;
  if (typeof a.duration === "number") input.duration = a.duration;
  if (typeof a.enableAudio === "boolean") input.enable_audio = a.enableAudio;
  return input;
}

function isVideoInput(a: GenInput): boolean {
  return Boolean(a.imageUrl || typeof a.duration === "number" || typeof a.enableAudio === "boolean");
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input) {
    const payload = {
      model: providerModel,
      input: isVideoInput(input) ? videoInput(input) : imageInput(input),
    };
    const r = await kieFetch<{ data: { taskId: string } }>(key, "/createTask", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!r?.data?.taskId) throw new ProviderError(502, "استجابة غير متوقعة من kie.ai (taskId مفقود)");
    return { providerTaskId: r.data.taskId };
  },

  async checkTask(key, providerTaskId): Promise<ProviderCheckResult> {
    const r = await kieFetch<{ data: Record<string, unknown> }>(
      key,
      `/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`
    );
    const d = r?.data ?? {};
    const state = String(d.state ?? "");
    if (state === "success") {
      // resultJson نص JSON داخل JSON — تحليل ثانٍ إلزامي
      let urls: string[] = [];
      try {
        const inner = JSON.parse(String(d.resultJson ?? "{}"));
        urls = Array.isArray(inner?.resultUrls)
          ? inner.resultUrls.filter((u: unknown) => typeof u === "string")
          : [];
      } catch {
        urls = [];
      }
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة دون روابط نتائج" };
      return { status: "completed", urls };
    }
    if (state === "fail") {
      return { status: "failed", error: String(d.failMsg ?? "فشل غير معروف لدى المزود") };
    }
    // تقدير تقدم تقريبي حسب الحالة (kie لا يوفر نسبة)
    const progress = state === "generating" ? 50 : state === "queuing" ? 15 : 5;
    return { status: "processing", progress };
  },
};
