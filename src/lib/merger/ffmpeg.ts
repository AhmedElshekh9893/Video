// محرك ffmpeg: ثنائيات ثابتة (ffmpeg-static/ffprobe-static) + فحص المصادر + ترميز الدمج عالي الجودة
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { spawn } from "child_process";
import { existsSync, copyFileSync, chmodSync, mkdirSync } from "fs";
import path from "path";
import os from "os";

export interface ProbeResult {
  width: number;
  height: number;
  fps: number;
  duration: number;
  hasAudio: boolean;
}

const g = globalThis as unknown as { __mgBins?: { ffmpeg: string; ffprobe: string } };

// قد يفقد الثنائي صلاحية التنفيذ في الاستضافة → انسخه إلى /tmp بصلاحية 755 عند الحاجة.
// إن غاب الثابت تمامًا نرجع لثنائي النظام (مفيد محليًا).
export async function ensureBins(): Promise<{ ffmpeg: string; ffprobe: string }> {
  if (g.__mgBins) return g.__mgBins;
  const tmp = os.tmpdir();
  mkdirSync(tmp, { recursive: true });

  const ffSrc = (ffmpegStatic as unknown as string) || "";
  let ffmpeg = "";
  if (ffSrc && existsSync(ffSrc)) {
    const dest = path.join(tmp, "mg-ffmpeg");
    try {
      if (!existsSync(dest)) {
        copyFileSync(ffSrc, dest);
        chmodSync(dest, 0o755);
      }
      ffmpeg = dest;
    } catch {
      ffmpeg = "";
    }
  }
  if (!ffmpeg) ffmpeg = "ffmpeg"; // بديل النظام

  const fpSrc = (ffprobeStatic as unknown as { path?: string })?.path ?? "";
  let ffprobe = "";
  if (fpSrc && existsSync(fpSrc)) {
    const dest = path.join(tmp, "mg-ffprobe");
    try {
      if (!existsSync(dest)) {
        copyFileSync(fpSrc, dest);
        chmodSync(dest, 0o755);
      }
      ffprobe = dest;
    } catch {
      ffprobe = "";
    }
  }
  if (!ffprobe) ffprobe = "ffprobe";

  g.__mgBins = { ffmpeg, ffprobe };
  return g.__mgBins;
}

// فحص توفر الثنائيات (يُستخدم في /api/health)
export async function binsHealthy(): Promise<boolean> {
  try {
    const bins = await ensureBins();
    return Boolean(bins.ffmpeg && bins.ffprobe);
  } catch {
    return false;
  }
}

function run(bin: string, args: string[], onStdoutLine?: (line: string) => void, timeoutMs = 280_000): Promise<{ code: number; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdoutBuf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("انتهت مهلة معالجة ffmpeg"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (!onStdoutLine) return;
      stdoutBuf += s;
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) onStdoutLine(line.trim());
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 16_000) stderr = stderr.slice(-16_000); // احتفظ بآخر جزء فقط
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderrTail: stderr.slice(-4000) });
    });
  });
}

// ffprobe: الدقة، معدل الإطارات، المدة، وجود صوت
export async function probeVideo(bin: string, file: string): Promise<ProbeResult> {
  const { code, stderrTail } = await run(
    bin,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
    undefined,
    60_000
  );
  if (code !== 0) throw new Error(`تعذر تحليل الملف: ${stderrTail.slice(0, 200)}`);
  const json = JSON.parse(await readStdout(bin, file));
  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const v = streams.find((s: Record<string, unknown>) => s.codec_type === "video");
  const a = streams.find((s: Record<string, unknown>) => s.codec_type === "audio");
  if (!v) throw new Error("المصدر لا يحتوي مسار فيديو صالحًا");
  const fpsRaw = String(v.avg_frame_rate ?? v.r_frame_rate ?? "30/1");
  let fps = 30;
  const m = fpsRaw.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (m) fps = Number(m[1]) / Number(m[2]) || 30;
  else if (Number.isFinite(Number(fpsRaw))) fps = Number(fpsRaw) || 30;
  const duration =
    Number(v.duration) ||
    Number((json?.format as Record<string, unknown>)?.duration) ||
    0;
  return {
    width: Number(v.width ?? 0),
    height: Number(v.height ?? 0),
    fps: Math.max(1, Math.min(120, fps)),
    duration: Math.max(0, duration),
    hasAudio: Boolean(a),
  };
}

// تنفيذ ffprobe منفصل لالتقاط stdout كامل (JSON)
async function readStdout(bin: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error("ffprobe failed"))));
  });
}

export interface EncodeOptions {
  inputs: Array<{ path: string; probe: ProbeResult }>;
  outPath: string;
  preset?: string;
  onProgress?: (ratio: number) => Promise<void>; // 0..1 من زمن الترميز
}

/**
 * ترميز الدمج بجودة عالية إلزامية:
 * - scale + pad إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080، أبعاد زوجية)
 * - fps=30، setsar=1، format=yuv420p ثم concat
 * - مصدر بلا صوت → مسار صامت anullsrc بنفس مدته بدل أن يفشل الدمج
 * - libx264 CRF 18 + AAC 192k/44100Hz + +faststart → MP4 يعمل فورًا على الويب
 */
export async function mergeEncode(bin: string, opts: EncodeOptions): Promise<void> {
  const { inputs, outPath } = opts;
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const maxW = Math.min(1920, even(Math.max(...inputs.map((i) => i.probe.width))));
  const maxH = Math.min(1080, even(Math.max(...inputs.map((i) => i.probe.height))));
  const preset = opts.preset || process.env.FFMPEG_PRESET || "medium";

  const args: string[] = ["-y"];
  const N = inputs.length;
  for (const i of inputs) args.push("-i", i.path);

  // مدخل صامت lavfi لكل مصدر بلا صوت (بُعده = مدة المصدر)
  const silentInputIndex = new Map<number, number>(); // seq → فهرس مدخل anullsrc
  let lavfiIdx = N;
  inputs.forEach((inp, i) => {
    if (!inp.probe.hasAudio) {
      args.push("-f", "lavfi", "-t", inp.probe.duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
      silentInputIndex.set(i, lavfiIdx++);
    }
  });

  const filters: string[] = [];
  inputs.forEach((inp, i) => {
    filters.push(
      `[${i}:v]scale=${maxW}:${maxH}:force_original_aspect_ratio=decrease,pad=${maxW}:${maxH}:(ow-iw)/2:(oh-ih)/2:black,fps=30,setsar=1,format=yuv420p[v${i}]`
    );
    if (inp.probe.hasAudio) {
      filters.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      const j = silentInputIndex.get(i)!;
      filters.push(`[${j}:a]aresample=44100[a${i}]`);
    }
  });
  const concatIn = inputs.map((_, i) => `[v${i}][a${i}]`).join("");
  filters.push(`${concatIn}concat=n=${N}:v=1:a=1[vout][aout]`);

  args.push(
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-crf", "18", "-preset", preset,
    "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
    "-movflags", "+faststart",
    "-progress", "pipe:1", "-nostats",
    outPath
  );

  const totalDur = inputs.reduce((s, i) => s + i.probe.duration, 0);
  const { code, stderrTail } = await run(bin, args, async (line) => {
    // قراءة out_time_us من -progress pipe:1 وحساب النسبة من المدة الإجمالية
    const m = line.match(/^out_time_us=(\d+)/);
    if (m && totalDur > 0 && opts.onProgress) {
      const t = Number(m[1]) / 1_000_000;
      const ratio = Math.max(0, Math.min(1, t / totalDur));
      try {
        await opts.onProgress(ratio);
      } catch {
        // لا تفشل الترميز بسبب فشل تحديث التقدم
      }
    }
  });
  if (code !== 0) {
    const tail = stderrTail.split("\n").filter(Boolean).slice(-3).join(" | ");
    throw new Error(`فشل ترميز ffmpeg: ${tail || `رمز الخروج ${code}`}`);
  }
}
