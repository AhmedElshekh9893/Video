// منسّق معالجة مهمة الدمج: سحب/قراءة المصادر → فحص → توحيد وترميز → تخزين الناتج في Turso
import { rm } from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { MERGE_LIMITS } from "../config";
import { ensureBins, probeVideo, mergeEncode } from "./ffmpeg";
import * as store from "./store";
import { lazyCleanup } from "./cleanup";

export interface DonePayload {
  status: "done";
  videoUrl: string;
  downloadUrl: string;
  size: number;
  duration: number;
  resolution: string;
  expiresAt: string;
}

export interface ProcessResult {
  kind: "done" | "failed" | "busy" | "notfound";
  payload?: DonePayload;
  error?: string;
}

export class JobNotFoundError extends Error {}

function fmtMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

// تنزيل مصدر رابط إلى /tmp مع عدّ بايتات وحد حجم صارم
async function downloadToFile(url: string, filePath: string, onBytes: (bytes: number) => Promise<void>): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(MERGE_LIMITS.downloadTimeoutSec * 1000) });
  } catch {
    throw new Error("تعذر الوصول إلى رابط المصدر (مهلة أو شبكة)");
  }
  if (!res.ok || !res.body) {
    throw new Error(`فشل تنزيل المصدر (HTTP ${res.status})`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared && declared > MERGE_LIMITS.sourceMaxBytes) {
    throw new Error(`حجم المصدر (${fmtMB(declared)}MB) يتجاوز الحد (${fmtMB(MERGE_LIMITS.sourceMaxBytes)}MB)`);
  }
  let count = 0;
  let lastReport = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      count += chunk.length;
      if (count > MERGE_LIMITS.sourceMaxBytes) {
        ctrl.error(new Error(`حجم المصدر يتجاوز الحد (${fmtMB(MERGE_LIMITS.sourceMaxBytes)}MB)`));
        return;
      }
      ctrl.enqueue(chunk);
    },
  });
  const reporting = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, ctrl) {
      if (Date.now() - lastReport > 1500) {
        lastReport = Date.now();
        await onBytes(count);
      }
      ctrl.enqueue(chunk);
    },
  });
  // عدّاد التحميل الكلي للمهام (0..40)
  await pipeline(
    Readable.fromWeb(res.body.pipeThrough(counter).pipeThrough(reporting) as never),
    createWriteStream(filePath)
  );
  await onBytes(count);
}

/**
 * معالجة مهمة دمج كاملة (متزامنة). استحواذ متفائل يمنع التنفيذ المزدوج.
 * - أي خطأ معلن من المصادر/الحدود = فشل نهائي برسالة عربية واضحة
 * - أخطاء شبكتنا المؤقتة تُعاد المحاولة عند استدعاء العملية مجددًا
 */
export async function processJob(jobId: string, origin: string): Promise<ProcessResult> {
  const job = await store.getJob(jobId);
  if (!job) throw new JobNotFoundError("مهمة الدمج غير موجودة");
  if (job.status === "done") {
    return { kind: "done", payload: donePayload(job, origin) };
  }
  if (job.status === "failed") {
    return { kind: "failed", error: job.error ?? "فشلت مهمة الدمج سابقًا" };
  }
  const claimed = await store.claimJob(jobId);
  if (!claimed) return { kind: "busy" };

  const tmpDir = path.join("/tmp", `mg-merge-${jobId}`);
  const outPath = path.join(tmpDir, "out.mp4");
  try {
    await lazyCleanup();

    const sources = await store.listSources(jobId);
    if (sources.length < 2) throw new Error("الدمج يحتاج مقطعَين على الأقل");
    if (sources.length > MERGE_LIMITS.maxSources) {
      throw new Error(`أقصى عدد مقاطع للدمج هو ${MERGE_LIMITS.maxSources}`);
    }

    const { mkdir: mkdirP } = await import("fs/promises");
    await mkdirP(tmpDir, { recursive: true });

    const { ensureSchema } = await import("../turso");
    await ensureSchema();

    // 1) تجهيز الملفات: تنزيل الروابط أو سكب الأجزاء المرفوعة (تقدم 0..40)
    const paths: string[] = [];
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const p = path.join(tmpDir, `src-${String(i).padStart(2, "0")}.bin`);
      if (src.kind === "url") {
        await downloadToFile(src.url ?? "", p, async (bytes) => {
          const pct = Math.min(39, Math.round((i / sources.length) * 40 + (bytes ? 5 : 0)));
          await store.updateJob(jobId, { progress: pct });
        });
      } else {
        const written = await store.dumpSourceChunksToFile(jobId, src.seq, p);
        const declared = src.size ?? 0;
        if (declared && written < declared) {
          throw new Error(`الملف «${src.name ?? src.seq}» لم يُرفع بالكامل (${fmtMB(written)} من ${fmtMB(declared)}MB)`);
        }
        if (!written) throw new Error(`الملف «${src.name ?? src.seq}» لا يحتوي أي بيانات مرفوعة`);
      }
      paths.push(p);
      await store.updateJob(jobId, { progress: Math.round(((i + 1) / sources.length) * 40) });
    }

    // 2) فحص كل مصدر بـ ffprobe
    const bins = await ensureBins();
    const probed: Array<{ path: string; probe: import("./ffmpeg").ProbeResult }> = [];
    let totalDur = 0;
    for (let i = 0; i < paths.length; i++) {
      let pr;
      try {
        pr = await probeVideo(bins.ffprobe, paths[i]);
      } catch (e) {
        throw new Error(`المصدر رقم ${i + 1} ليس فيديو صالحًا: ${(e as Error).message}`);
      }
      if (pr.duration <= 0) throw new Error(`المصدر رقم ${i + 1} بلا مدة قابلة للقياس`);
      totalDur += pr.duration;
      probed.push({ path: paths[i], probe: pr });
    }
    if (totalDur > MERGE_LIMITS.maxTotalDurationSec) {
      throw new Error(`مجموع مدد المقاطع (${Math.round(totalDur)} ثانية) يتجاوز الحد (${MERGE_LIMITS.maxTotalDurationSec} ثانية)`);
    }

    // 3) الترميز الموحد عالي الجودة (تقدم 40..90)
    await mergeEncode(bins.ffmpeg, {
      inputs: probed,
      outPath,
      onProgress: async (ratio) => {
        const pct = 40 + Math.round(ratio * 50);
        await store.updateJob(jobId, { progress: Math.min(90, pct) });
      },
    });

    // 4) فحص حجم الناتج
    const { stat } = await import("fs/promises");
    const size = (await stat(outPath)).size;
    if (size > MERGE_LIMITS.outputMaxBytes) {
      throw new Error(`حجم الناتج (${fmtMB(size)}MB) يتجاوز الحد (${fmtMB(MERGE_LIMITS.outputMaxBytes)}MB)`);
    }

    // 5) تخزين الناتج في Turso (تقدم 90..99)
    await store.writeOutputFile(jobId, outPath, async (ratio) => {
      await store.updateJob(jobId, { progress: 90 + Math.round(ratio * 9) });
    });

    // 6) فحص الناتج لدقته ومدته الفعليتين، ثم إخلاء أجزاء المصادر — الناتج فقط هو المطلوب
    const outProbe = await probeVideo(bins.ffprobe, outPath).catch(() => null);
    const resolution = outProbe ? `${outProbe.width}x${outProbe.height}` : `${Math.max(...probed.map((p) => p.probe.width))}x${Math.max(...probed.map((p) => p.probe.height))}`;
    const duration = outProbe?.duration ?? totalDur;
    await store.deleteSourceChunks(jobId);
    await store.updateJob(jobId, {
      status: "done", progress: 100, error: null,
      video_size: size, duration, resolution,
    });

    const fresh = await store.getJob(jobId);
    return fresh
      ? { kind: "done", payload: donePayload(fresh, origin) }
      : { kind: "failed", error: "فُقدت المهمة بعد الاكتمال" };
  } catch (e) {
    const msg = (e as Error)?.message ?? "خطأ غير معروف أثناء الدمج";
    await store.updateJob(jobId, { status: "failed", error: msg });
    return { kind: "failed", error: msg };
  } finally {
    // لا اعتماد على نظام ملفات دائم — نظّف /tmp دائمًا
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function donePayload(job: store.JobRow, origin: string): DonePayload {
  const videoUrl = `${origin}/api/jobs/${job.id}/video`;
  return {
    status: "done",
    videoUrl,
    downloadUrl: `${videoUrl}?download=1`,
    size: job.video_size ?? 0,
    duration: job.duration ?? 0,
    resolution: job.resolution ?? "",
    expiresAt: job.expires_at,
  };
}
