// مزود CometAPI — وفق توثيقهم الرسمي الحالي (apidoc.cometapi.com):
// - الصور متزامنة: POST /v1/images/generations (متوافق مع OpenAI) → data[0].url أو b64_json
// - الفيديو غير متزامن: POST /grok/v1/videos/generations → {request_id}
//   ثم GET /grok/v1/videos/{request_id} → {status: pending|done|failed|expired, video:{url}, error}
import { ProviderError } from "../keys";
import type { ProviderAdapter, GenInput, ProviderCheckResult } from "./types";
import type { ApiKeyRow } from "../keys-db";

const BASE = "https://api.cometapi.com";

async function cometFetch<T>(key: ApiKeyRow, url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${key.api_key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new ProviderError(undefined, `network: ${(e as Error)?.message ?? e}`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = body as Record<string, unknown>;
    const msg = (b?.error as Record<string, unknown>)?.message ?? b?.message ?? `HTTP ${res.status}`;
    throw new ProviderError(res.status, String(msg));
  }
  return body as T;
}

// تحويل نسبة الأبعاد إلى size بصيغة OpenAI
function imageSize(a: GenInput): string {
  const ar = a.aspectRatio ?? "auto";
  if (["16:9", "3:2", "21:9", "2:1"].includes(ar)) return "1536x1024";
  if (["9:16", "2:3", "9:21", "1:2"].includes(ar)) return "1024x1536";
  return "1024x1024";
}

export const cometapiAdapter: ProviderAdapter = {
  async createTask(key, providerModel, input: GenInput) {
    // فيديو Grok عبر نقطة xAI غير المتزامنة
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt: input.prompt,
    };
    if (input.imageUrl) payload.image = { url: input.imageUrl };
    if (input.aspectRatio && input.aspectRatio !== "auto") payload.aspect_ratio = input.aspectRatio;
    if (input.resolution) payload.resolution = input.resolution;
    if (typeof input.duration === "number") payload.duration = input.duration;
    const r = await cometFetch<{ request_id?: string }>(key, `${BASE}/grok/v1/videos/generations`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!r?.request_id) throw new ProviderError(502, "استجابة غير متوقعة من CometAPI (request_id مفقود)");
    return { providerTaskId: r.request_id };
  },

  async checkTask(key, providerTaskId): Promise<ProviderCheckResult> {
    const r = await cometFetch<Record<string, unknown>>(
      key,
      `${BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`
    );
    const status = String(r?.status ?? "pending");
    if (status === "done") {
      const url = ((r?.video as Record<string, unknown>)?.url as string) ?? null;
      if (!url) return { status: "failed", error: "اكتملت المهمة دون رابط فيديو" };
      return { status: "completed", urls: [url] };
    }
    if (status === "failed" || status === "expired") {
      const err = r?.error;
      const msg =
        typeof err === "string"
          ? err
          : (((err as Record<string, unknown>)?.message as string) ?? "فشل غير معروف لدى المزود");
      return { status: "failed", error: msg };
    }
    const progress = typeof r?.progress === "number" ? Math.min(99, Math.max(5, r.progress)) : 30;
    return { status: "processing", progress };
  },
};

// تنفيذ حقيقي للصور المتزامنة (CometAPI تعيد النتيجة فورًا)
export async function cometCreateImageSync(
  key: ApiKeyRow,
  providerModel: string,
  input: GenInput
): Promise<{ urls: string[] }> {
  const body = {
    model: providerModel,
    prompt: input.prompt,
    n: 1,
    size: imageSize(input),
  };
  const r = await cometFetch<Record<string, unknown>>(key, `${BASE}/v1/images/generations`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const data = Array.isArray(r?.data) ? r.data : [];
  const urls: string[] = [];
  for (const item of data) {
    const it = item as Record<string, unknown>;
    if (typeof it?.url === "string" && it.url) urls.push(it.url);
    else if (typeof it?.b64_json === "string" && it.b64_json.length < 8 * 1024 * 1024) {
      // b64 بدون رابط عام → data URL (بحد أقصى 8MB حفاظًا على قاعدة البيانات)
      // لا ننزّل أي وسائط إلى سيرفرنا — الالتزام بقاعدة الروابط فقط
      urls.push(`data:image/png;base64,${it.b64_json}`);
    }
  }
  if (!urls.length) throw new ProviderError(502, "لم تُعَد أي صورة من CometAPI");
  return { urls };
}
