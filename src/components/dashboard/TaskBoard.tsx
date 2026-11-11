"use client";

// بطاقة لوحة المهام: شرائح إحصائيات + قائمة تتحدث تلقائيًا كل ~5 ثوانٍ
import { useCallback, useEffect, useRef, useState } from "react";

interface TaskItem {
  id: string;
  type: "image" | "video" | "merge";
  model: string;
  provider: string | null;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  prompt: string;
  error: string | null;
  urls: string[];
  attempts: number;
  created_at: string;
}

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const TYPE_ICON: Record<TaskItem["type"], string> = { image: "🖼️", video: "🎬", merge: "🎞️" };
const TYPE_TEXT: Record<TaskItem["type"], string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function statusBadge(s: TaskItem["status"], progress: number) {
  if (s === "completed")
    return <span className="rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-300">مكتملة</span>;
  if (s === "failed")
    return <span className="rounded-full border border-rose-500/30 bg-rose-500/15 px-2 py-0.5 text-[11px] font-bold text-rose-300">فاشلة</span>;
  return (
    <span className="rounded-full border border-cyan-500/30 bg-cyan-500/15 px-2 py-0.5 text-[11px] font-bold text-cyan-300">
      {s === "pending" ? "منتظرة" : `جارية ${Math.round(progress)}%`}
    </span>
  );
}

function timeAgo(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  if (!Number.isFinite(d)) return "";
  const m = Math.floor(d / 60000);
  if (m < 1) return "الآن";
  if (m < 60) return `قبل ${m} دقيقة`;
  const h = Math.floor(m / 60);
  if (h < 24) return `قبل ${h} ساعة`;
  return `قبل ${Math.floor(h / 24)} يوم`;
}

export default function TaskBoard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const data = await res.json();
      if (mounted.current) {
        setStats(data.stats ?? null);
        setTasks(data.tasks ?? []);
      }
    } catch {
      /* تجاهل */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(load, 5000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [load]);

  const chip = (label: string, val: number | undefined, cls: string) => (
    <div className={`rounded-xl border px-4 py-2 text-center ${cls}`}>
      <div className="text-xl font-extrabold">{val ?? "…"}</div>
      <div className="text-[11px] opacity-80">{label}</div>
    </div>
  );

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-6 backdrop-blur">
      <h2 className="mb-4 text-lg font-bold text-purple-300">📋 لوحة المهام</h2>

      <div className="mb-5 grid grid-cols-4 gap-2 sm:gap-3">
        {chip("الإجمالي", stats?.total, "border-white/10 bg-white/5 text-slate-200")}
        {chip("مكتملة", stats?.completed, "border-emerald-500/20 bg-emerald-500/10 text-emerald-300")}
        {chip("فاشلة", stats?.failed, "border-rose-500/20 bg-rose-500/10 text-rose-300")}
        {chip("جارية", stats?.processing, "border-cyan-500/20 bg-cyan-500/10 text-cyan-300")}
      </div>

      <div className="mg-scroll max-h-96 overflow-y-auto rounded-xl border border-white/5">
        {tasks.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">لا توجد مهام بعد — استخدم أدوات MCP لتوليد أول وسائط</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {tasks.map((t) => (
              <li key={t.id} className="p-3.5 text-sm">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span title={t.type}>{TYPE_ICON[t.type]}</span>
                  <span className="text-xs font-bold text-slate-300">{TYPE_TEXT[t.type]}</span>
                  <code dir="ltr" className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{t.model}</code>
                  {statusBadge(t.status, t.progress)}
                  {t.attempts > 0 && (
                    <span className="text-[11px] text-amber-400/80" title="عدد المحاولات على المفاتيح">
                      محاولات: {t.attempts}
                    </span>
                  )}
                  <span className="ms-auto text-[11px] text-slate-500">{timeAgo(t.created_at)}</span>
                </div>
                {t.prompt && <p className="mb-1.5 truncate text-xs text-slate-400" dir="auto">«{t.prompt}»</p>}
                {(t.status === "processing" || t.status === "pending") && (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div
                      className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-purple-400 transition-all duration-500"
                      style={{ width: `${Math.max(4, Math.min(100, t.progress))}%` }}
                    />
                  </div>
                )}
                {t.status === "failed" && t.error && <p className="text-xs text-rose-400/90">❌ {t.error}</p>}
                {t.urls.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-2">
                    {t.urls.map((u, i) => (
                      <a
                        key={i}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        dir="ltr"
                        className="max-w-[260px] truncate rounded-md border border-cyan-500/25 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-300 transition hover:bg-cyan-500/20"
                      >
                        {u.startsWith("data:") ? "صورة (data URL)" : u}
                      </a>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
