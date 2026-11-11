"use client";

// لوحة الإدارة العربية (RTL) — أربع بطاقات: المفاتيح، المهام، ربط السيرفر، استوديو الدمج
import { useCallback, useEffect, useState } from "react";
import KeyManager from "@/components/dashboard/KeyManager";
import TaskBoard from "@/components/dashboard/TaskBoard";
import ConnectCard from "@/components/dashboard/ConnectCard";
import MergeStudio from "@/components/dashboard/MergeStudio";

interface Health {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  merger: { mode: string; base: string; healthy: boolean };
  authRequired: boolean;
}

function Badge({ ok, onText, offText }: { ok: boolean; onText: string; offText: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold ${
        ok ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30" : "bg-rose-500/15 text-rose-300 border border-rose-500/30"
      }`}
    >
      <span className={`h-2 w-2 rounded-full ${ok ? "bg-emerald-400 animate-pulse" : "bg-rose-400"}`} />
      {ok ? onText : offText}
    </span>
  );
}

export default function Home() {
  const [health, setHealth] = useState<Health | null>(null);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    loadHealth();
    const t = setInterval(loadHealth, 8000);
    return () => clearInterval(t);
  }, [loadHealth]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900">
      {/* هالات خلفية بتدرجات سماوي/بنفسجي */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-40 right-1/4 h-96 w-96 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="absolute top-1/3 -left-32 h-96 w-96 rounded-full bg-purple-600/10 blur-3xl" />
      </div>

      <main className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* الهيدر */}
        <header className="mb-10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="bg-gradient-to-l from-cyan-300 via-sky-200 to-purple-300 bg-clip-text text-3xl font-extrabold text-transparent sm:text-4xl">
                مولد الوسائط بالذكاء الاصطناعي
              </h1>
              <p className="mt-2 text-sm text-slate-400">
                خادم MCP لتوليد الصور والفيديو ودمج المقاطع — مفاتيح متعددة بتبديل تسلسلي تلقائي دون توقف
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                ok={health?.database === "turso-connected"}
                onText="Turso متصل"
                offText="Turso غير متصل"
              />
              <Badge
                ok={Boolean(health?.merger?.healthy)}
                onText={`خدمة الدمج جاهزة (${health?.merger?.mode === "external" ? "خارجية" : "داخلية"})`}
                offText="خدمة الدمج غير جاهزة"
              />
              {health?.authRequired && (
                <span className="rounded-full border border-amber-500/30 bg-amber-500/15 px-3 py-1 text-xs font-bold text-amber-300">
                  محمي بـ MCP_ACCESS_TOKEN
                </span>
              )}
            </div>
          </div>
        </header>

        {/* البطاقات */}
        <div className="flex flex-col gap-6">
          <KeyManager />
          <TaskBoard />
          <ConnectCard authRequired={Boolean(health?.authRequired)} />
          <MergeStudio />
        </div>

        <footer className="mt-12 pb-6 text-center text-xs text-slate-500">
          روابط فقط — لا تُنزَّل أي وسائط إلى السيرفر · التبديل بين المفاتيح تسلسلي صامت · ملفات الدمج تُحذف بعد ~24 ساعة
        </footer>
      </main>
    </div>
  );
}
