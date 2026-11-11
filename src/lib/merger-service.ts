// واجهة خدمة الدمج بتنفيذين:
// - internal: التطبيق يستضيف خدمة الدمج داخليًا (استدعاء مباشر للمحرك — بلا قفزة HTTP، الأنسب لـ Serverless)
// - external: خدمة دمج خارجية عبر HTTP عند ضبط MERGER_API_BASE (توافق كامل مع Video Merger API v2)
import { MERGE_LIMITS, mergerExternalBase } from "./config";
import * as store from "./merger/store";
import { processJob, donePayload, JobNotFoundError } from "./merger/runner";
import { expiryIso, lazyCleanup } from "./merger/cleanup";

export interface MergerJobStatus {
  status: "queued" | "uploading" | "processing" | "done" | "failed";
  progress: number;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
  expiresAt?: string;
}

export interface CreateJobResult {
  jobId: string;
  status: "queued" | "uploading";
  expiresAt: string;
}

export interface MergerService {
  mode: "internal" | "external";
  createJob(videos: string[]): Promise<CreateJobResult>;
  startProcess(jobId: string, origin: string): Promise<MergerJobStatus>;
  getJob(jobId: string, origin: string): Promise<MergerJobStatus>;
}

// ─── التنفيذ الداخلي ───
class InternalMerger implements MergerService {
  mode = "internal" as const;

  async createJob(videos: string[]): Promise<CreateJobResult> {
    await lazyCleanup();
    const jobId = store.newJobId();
    const expiresAt = expiryIso();
    const now = new Date().toISOString();
    await store.getJob(jobId); // ensureSchema ضمنيًا عبر الاستدعاءات
    await dbInsertJob(jobId, now, expiresAt);
    await store.insertSources(jobId, videos.map((url) => ({ kind: "url" as const, url })));
    return { jobId, status: "queued", expiresAt };
  }

  async startProcess(jobId: string, origin: string): Promise<MergerJobStatus> {
    const r = await processJob(jobId, origin);
    if (r.kind === "done") {
      const p = r.payload!;
      return { status: "done" as const, progress: 100, videoUrl: p.videoUrl, downloadUrl: p.downloadUrl, size: p.size, duration: p.duration, resolution: p.resolution, expiresAt: p.expiresAt };
    }
    if (r.kind === "failed") return { status: "failed", progress: 100, error: r.error };
    const job = await store.getJob(jobId);
    return { status: job?.status ?? "processing", progress: job?.progress ?? 0, error: job?.error ?? undefined, expiresAt: job?.expires_at };
  }

  async getJob(jobId: string, origin: string): Promise<MergerJobStatus> {
    const job = await store.getJob(jobId);
    if (!job) throw new JobNotFoundError("مهمة الدمج غير موجودة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (job.status === "done") {
      const dp = donePayload(job, origin);
      return { status: "done" as const, progress: 100, videoUrl: dp.videoUrl, downloadUrl: dp.downloadUrl, size: dp.size, duration: dp.duration, resolution: dp.resolution, expiresAt: dp.expiresAt };
    }
    return { status: job.status, progress: job.progress, error: job.error ?? undefined, expiresAt: job.expires_at };
  }
}

async function dbInsertJob(jobId: string, now: string, expiresAt: string): Promise<void> {
  const { db, ensureSchema } = await import("./turso");
  await ensureSchema();
  await db().execute({
    sql: "INSERT INTO jobs (id, status, progress, created_at, updated_at, expires_at) VALUES (?, 'queued', 0, ?, ?, ?)",
    args: [jobId, now, now, expiresAt] as never,
  });
}

// ─── التنفيذ الخارجي (خدمة دمج على نطاق آخر) ───
class ExternalMerger implements MergerService {
  mode = "external" as const;
  constructor(private base: string) {}

  private statusUrl(id: string) { return `${this.base}/api/jobs/${id}`; }

  async createJob(videos: string[]): Promise<CreateJobResult> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videos }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new Error(`تعذر الاتصال بخدمة الدمج: ${(e as Error).message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !(body as Record<string, unknown>)?.jobId) {
      throw new Error(`رفضت خدمة الدمج إنشاء المهمة (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
    }
    const b = body as Record<string, unknown>;
    return { jobId: String(b.jobId), status: (b.status as "queued") ?? "queued", expiresAt: String(b.expiresAt ?? "") };
  }

  async startProcess(jobId: string, _origin: string): Promise<MergerJobStatus> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST", signal: AbortSignal.timeout(280_000) });
    } catch {
      // خطأ شبكتنا نحن = مؤقت → استمر بالاستعلام حتى انتهاء النافذة
      return { status: "processing", progress: 0 };
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 202) return { status: "processing", progress: Number(body?.progress ?? 0) };
    if (res.ok && String(body?.status) === "done") {
      return {
        status: "done", progress: 100,
        videoUrl: String(body?.videoUrl ?? ""), downloadUrl: String(body?.downloadUrl ?? ""),
        size: Number(body?.size ?? 0), duration: Number(body?.duration ?? 0),
        resolution: String(body?.resolution ?? ""), expiresAt: String(body?.expiresAt ?? ""),
      };
    }
    if (res.status >= 400) {
      // أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري (لا إعادة محاولة)
      return { status: "failed", progress: 100, error: String(body?.error ?? `HTTP ${res.status}`) };
    }
    return { status: "processing", progress: Number(body?.progress ?? 0) };
  }

  async getJob(jobId: string, origin: string): Promise<MergerJobStatus> {
    let res: Response;
    try {
      res = await fetch(this.statusUrl(encodeURIComponent(jobId)), { signal: AbortSignal.timeout(20_000) });
    } catch {
      return { status: "processing", progress: 0 }; // شبكتنا — مؤقت
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 404) {
      throw new JobNotFoundError("مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    }
    // دفاعي: قد يرد الجسم فيه error بدون حقل status → عاملها failed فورًا
    let raw = String(body?.status ?? "").toLowerCase();
    if (!raw && body?.error) raw = "failed";
    const doneWords = ["done", "completed", "complete", "success", "succeeded", "finished"];
    const failWords = ["error", "failed", "failure", "cancelled"];
    let status: MergerJobStatus["status"] = "processing";
    if (doneWords.includes(raw)) status = "done";
    else if (failWords.includes(raw)) status = "failed";
    let progress = Number(body?.progress ?? 0);
    if (progress > 0 && progress <= 1) progress = Math.round(progress * 100); // يأتي أحيانًا كسرًا 0..1
    if (status === "done") {
      // فضّل videoUrl ثم downloadUrl وإن غابا فاضبط رابط الفيديو من jobId
      const videoUrl = String(body?.videoUrl || body?.downloadUrl || `${this.base}/api/jobs/${encodeURIComponent(jobId)}/video`);
      return {
        status: "done", progress: 100, videoUrl,
        downloadUrl: String(body?.downloadUrl || `${videoUrl}${videoUrl.includes("?") ? "&" : "?"}download=1`),
        size: Number(body?.size ?? 0), duration: Number(body?.duration ?? 0),
        resolution: String(body?.resolution ?? ""), expiresAt: String(body?.expiresAt ?? ""),
      };
    }
    return { status, progress, error: body?.error ? String(body.error) : undefined };
  }
}

let _svc: MergerService | null = null;

export function getMergerService(): MergerService {
  if (!_svc) {
    const ext = mergerExternalBase();
    _svc = ext ? new ExternalMerger(ext) : new InternalMerger();
  }
  return _svc;
}

// حدود الخدمة الحالية (تُستخدم في /api/config و /api/health)
export function mergerLimitsJson() {
  return {
    maxSources: MERGE_LIMITS.maxSources,
    sourceMaxMB: Math.round(MERGE_LIMITS.sourceMaxBytes / 1024 / 1024),
    outputMaxMB: Math.round(MERGE_LIMITS.outputMaxBytes / 1024 / 1024),
    maxTotalDurationSec: MERGE_LIMITS.maxTotalDurationSec,
    uploadChunkBytes: MERGE_LIMITS.uploadChunkBytes,
    retentionHours: MERGE_LIMITS.retentionHours,
  };
}
