"use client";

// استوديو الدمج: روابط + ملفات من الجهاز (رفع أجزاء 4MB مع إعادة محاولة ×3)
// ترتيب القائمة = ترتيب الدمج، متابعة التقدم من الخادم، مشغل نتيجة + عدّاد 24 ساعة
import { useCallback, useEffect, useRef, useState } from "react";

interface SourceItem {
  key: string; // معرّف محلي للقائمة
  kind: "url" | "file";
  url?: string;
  file?: File;
  name: string;
  size: number;
  uploaded: number; // بايتات مرفوعة (للملفات)
  uploadSeq?: number; // seq لدى الخادم
}

interface JobResult {
  jobId: string;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  expiresAt?: string;
}

const ACCEPT = ".mp4,.mov,.webm,.mkv,.avi,.m4v,.mpg,.3gp";
const CHUNK = 4 * 1024 * 1024;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export default function MergeStudio() {
  const [urlInput, setUrlInput] = useState("");
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [phase, setPhase] = useState<"idle" | "uploading" | "processing" | "done" | "failed">("idle");
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<JobResult | null>(null);
  const [remaining, setRemaining] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const busy = phase === "uploading" || phase === "processing";
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  // استئناف العرض بعد تحديث الصفحة عبر #job=<id>
  useEffect(() => {
    const m = window.location.hash.match(/#job=([a-z0-9]+)/i);
    if (!m) return;
    const jobId = m[1];
    (async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (j.status === "done") {
          setResult(j);
          setPhase("done");
        } else if (j.status === "failed") {
          setPhase("failed");
          setError(j.error ?? "فشلت المهمة");
        } else {
          setPhase("processing");
          setProgress(j.progress ?? 0);
          pollJob(jobId);
        }
      } catch {
        /* تجاهل */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // عدّاد تنازلي حتى انتهاء الصلاحية (24 ساعة)
  useEffect(() => {
    if (!result?.expiresAt) return;
    const t = setInterval(() => {
      const ms = Date.parse(result.expiresAt!) - Date.now();
      if (ms <= 0) {
        setRemaining("انتهت الصلاحية");
        return;
      }
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      setRemaining(`${h} ساعة ${m} دقيقة ${s} ثانية`);
    }, 1000);
    return () => clearInterval(t);
  }, [result?.expiresAt]);

  // استطلاع حالة مهمة الدمج من الخادم
  const pollJob = useCallback(async (jobId: string) => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        const j = await res.json();
        if (j.status === "done") {
          setResult(j);
          setProgress(100);
          setPhase("done");
          return;
        }
        if (j.status === "failed") {
          setPhase("failed");
          setError(j.error ?? "فشلت المهمة");
          return;
        }
        setProgress(j.progress ?? 0);
      } catch {
        /* خطأ شبكة — تابع الاستطلاع */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function addUrl() {
    const u = urlInput.trim();
    if (!/^https?:\/\//i.test(u)) return;
    setSources((s) => [...s, { key: Math.random().toString(36).slice(2), kind: "url", url: u, name: u.split("/").pop() || u, size: 0, uploaded: 0 }]);
    setUrlInput("");
  }

  function addFiles(files: FileList | File[]) {
    const items = Array.from(files).map((f) => ({
      key: Math.random().toString(36).slice(2),
      kind: "file" as const,
      file: f,
      name: f.name,
      size: f.size,
      uploaded: 0,
    }));
    setSources((s) => [...s, ...items]);
  }

  function move(i: number, dir: -1 | 1) {
    setSources((s) => {
      const j = i + dir;
      if (j < 0 || j >= s.length) return s;
      const copy = [...s];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  }

  function removeAt(i: number) {
    setSources((s) => s.filter((_, idx) => idx !== i));
  }

  // رفع ملف واحد أجزاءً 4MB مع إعادة محاولة ×3 لكل جزء
  async function uploadFile(jobId: string, item: SourceItem, seq: number): Promise<void> {
    const file = item.file!;
    const chunks = Math.ceil(file.size / CHUNK);
    for (let c = 0; c < chunks; c++) {
      const slice = file.slice(c * CHUNK, Math.min((c + 1) * CHUNK, file.size));
      let ok = false;
      let lastErr = "";
      for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
        try {
          const res = await fetch(`/api/upload?job=${jobId}&seq=${seq}&chunk=${c}`, {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body: slice,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          ok = true;
        } catch (e) {
          lastErr = (e as Error).message;
          await new Promise((r) => setTimeout(r, 800 * attempt)); // انتظار قبل إعادة المحاولة
        }
      }
      if (!ok) throw new Error(`فشل رفع الجزء ${c + 1}/${chunks} من «${file.name}» (${lastErr})`);
      setSources((s) => s.map((x) => (x.key === item.key ? { ...x, uploaded: Math.min((c + 1) * CHUNK, file.size) } : x)));
    }
  }

  async function startMerge() {
    if (sources.length < 2 || busy) return;
    setPhase("uploading");
    setError("");
    setResult(null);
    setProgress(0);
    setStage("إنشاء مهمة الدمج…");
    try {
      const payload = {
        sources: sourcesRef.current.map((s) =>
          s.kind === "url"
            ? { kind: "url", url: s.url }
            : { kind: "file", name: s.name, size: s.size, mime: s.file?.type || "video/mp4" }
        ),
      };
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "تعذر إنشاء المهمة");

      // حفظ معرّف المهمة في العنوان لاستئناف العرض بعد تحديث الصفحة
      window.location.hash = `job=${data.jobId}`;

      // رفع الملفات بالتسلسل
      const uploads: Array<{ seq: number }> = data.uploads ?? [];
      const fileItems = sourcesRef.current.filter((s) => s.kind === "file");
      if (fileItems.length) {
        for (let i = 0; i < fileItems.length; i++) {
          const item = fileItems[i];
          const up = uploads[i];
          if (!up) throw new Error("لم يستلم الخادم رابط الرفع لهذا الملف");
          setStage(`رفع «${item.name}» …`);
          await uploadFile(data.jobId, item, up.seq);
        }
      }

      setPhase("processing");
      setStage("جارٍ الدمج على الخادم…");
      // إطلاق المعالجة ثم متابعة التقدم
      const p = fetch(`/api/jobs/${data.jobId}/process`, { method: "POST" }).catch(() => null);
      pollJob(data.jobId);
      await p;
    } catch (e) {
      setPhase("failed");
      setError((e as Error).message);
    }
  }

  async function copyLink() {
    if (result?.videoUrl) {
      try {
        await navigator.clipboard.writeText(result.videoUrl);
      } catch { /* تجاهل */ }
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-6 backdrop-blur">
      <h2 className="mb-1 text-lg font-bold text-violet-300">🎞️ استوديو دمج الفيديو</h2>
      <p className="mb-4 text-xs text-slate-400">
        ترتيب القائمة هو ترتيب الدمج · حتى 10 مقاطع · 200MB لكل مصدر · الناتج MP4 (H.264 + AAC) حتى 1080p ويُحذف بعد ~24 ساعة
      </p>

      {/* إضافة رابط */}
      <div className="mb-3 flex gap-2">
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addUrl()}
          dir="ltr"
          placeholder="https://example.com/clip.mp4"
          className="flex-1 rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-violet-400/50"
          aria-label="رابط فيديو مباشر"
        />
        <button onClick={addUrl} className="rounded-lg border border-violet-500/40 bg-violet-500/15 px-4 py-2 text-sm font-bold text-violet-300 transition hover:bg-violet-500/25">
          إضافة
        </button>
      </div>

      {/* منطقة سحب وإفلات */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
        className={`mb-4 cursor-pointer rounded-xl border-2 border-dashed p-6 text-center text-sm transition ${
          dragOver ? "border-violet-400 bg-violet-500/10 text-violet-200" : "border-white/15 text-slate-400 hover:border-violet-400/50"
        }`}
        onClick={() => document.getElementById("mg-file-input")?.click()}
      >
        اسحب ملفات فيديو هنا أو انقر للاختيار
        <div className="mt-1 text-[11px] text-slate-500">mp4 / mov / webm / mkv / avi / m4v / mpg / 3gp</div>
        <input
          id="mg-file-input"
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => e.target.files && addFiles(e.target.files)}
        />
      </div>

      {/* قائمة المصادر */}
      {sources.length > 0 && (
        <ul className="mg-scroll mb-4 max-h-64 space-y-2 overflow-y-auto rounded-xl border border-white/5 p-2">
          {sources.map((s, i) => (
            <li key={s.key} className="flex items-center gap-2 rounded-lg bg-slate-900/70 p-2 text-sm">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-violet-500/20 text-xs font-bold text-violet-300">
                {i + 1}
              </span>
              <span className="shrink-0">{s.kind === "url" ? "🔗" : "📁"}</span>
              <span dir="ltr" className="min-w-0 flex-1 truncate text-xs text-slate-300">{s.name}</span>
              {s.kind === "file" && s.size > 0 && (
                <span className="shrink-0 text-[11px] text-slate-500">
                  {busy && s.uploaded > 0 ? `${fmtSize(s.uploaded)} / ${fmtSize(s.size)}` : fmtSize(s.size)}
                </span>
              )}
              <span className="flex shrink-0 gap-1">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded border border-white/10 px-1.5 text-xs disabled:opacity-30" aria-label="أعلى">↑</button>
                <button onClick={() => move(i, 1)} disabled={i === sources.length - 1} className="rounded border border-white/10 px-1.5 text-xs disabled:opacity-30" aria-label="أسفل">↓</button>
                <button onClick={() => removeAt(i)} disabled={busy} className="rounded border border-rose-500/30 px-1.5 text-xs text-rose-300 disabled:opacity-30" aria-label="حذف">✕</button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* زر الدمج + التقدم */}
      <button
        onClick={startMerge}
        disabled={sources.length < 2 || busy}
        className="w-full rounded-xl bg-gradient-to-l from-violet-500 to-cyan-500 py-3 text-sm font-extrabold text-white transition hover:opacity-90 disabled:opacity-40"
      >
        {busy ? "جارٍ الدمج…" : `دمج الفيديوهات (${sources.length})`}
      </button>

      {(busy || phase === "done" || phase === "failed") && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[11px] text-slate-400">
            <span>{phase === "failed" ? "فشل" : phase === "done" ? "اكتمل" : stage || "…"}</span>
            <span>{progress}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full rounded-full transition-all duration-500 ${phase === "failed" ? "bg-rose-500" : "bg-gradient-to-l from-violet-400 to-cyan-400"}`}
              style={{ width: `${Math.max(3, progress)}%` }}
            />
          </div>
        </div>
      )}

      {error && <p className="mt-3 rounded-lg bg-rose-500/10 p-3 text-xs text-rose-300">❌ {error}</p>}

      {/* النتيجة */}
      {phase === "done" && result?.videoUrl && (
        <div className="mt-5 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
          <video controls src={result.videoUrl} className="mb-3 max-h-80 w-full rounded-lg bg-black" />
          <div className="mb-3 flex flex-wrap gap-3 text-xs text-slate-300">
            <span>💾 الحجم: {result.size ? fmtSize(result.size) : "—"}</span>
            <span>⏱️ المدة: {result.duration ? `${Math.round(result.duration)} ثانية` : "—"}</span>
            <span>🖥️ الدقة: {result.resolution || "—"}</span>
            {result.expiresAt && <span>⌛ يُحذف بعد: <span dir="ltr">{remaining}</span></span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <a href={result.downloadUrl ?? result.videoUrl} className="rounded-lg bg-gradient-to-l from-emerald-500 to-cyan-500 px-4 py-2 text-xs font-bold text-white hover:opacity-90">
              ⬇️ تحميل
            </a>
            <button onClick={copyLink} className="rounded-lg border border-white/10 px-4 py-2 text-xs text-slate-200 hover:bg-white/10">
              📋 نسخ الرابط
            </button>
            <button
              onClick={() => { setPhase("idle"); setResult(null); setSources([]); setProgress(0); window.location.hash = ""; }}
              className="rounded-lg border border-white/10 px-4 py-2 text-xs text-slate-200 hover:bg-white/10"
            >
              🔄 عملية جديدة
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
