"use client";

// بطاقة مدير المفاتيح: إضافة/تعطيل/تنشيط/حذف — المفاتيح مُقنَّعة دائمًا
import { useCallback, useEffect, useRef, useState } from "react";

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  masked: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_error: string | null;
  created_at: string;
}

const STATUS_STYLE: Record<KeyItem["status"], { text: string; cls: string }> = {
  active: { text: "نشط", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  exhausted: { text: "مستنزف", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
  disabled: { text: "معطّل", cls: "bg-slate-500/15 text-slate-400 border-slate-500/30" },
};

export default function KeyManager() {
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = await res.json();
      if (mounted.current) setKeys(data.keys ?? []);
    } catch {
      /* تجاهل أخطاء الاستطلاع الدوري */
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(load, 10000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [load]);

  async function addKey(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setMsg({ kind: "ok", text: `أُضيف المفتاح ${data.key.masked} — سيُجرَّب حسب ترتيب الإضافة` });
        setApiKey("");
        setLabel("");
        load();
      } else {
        setMsg({ kind: "err", text: data.error ?? "فشل الإضافة" });
      }
    } catch {
      setMsg({ kind: "err", text: "تعذر الاتصال بالسيرفر" });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: k.status === "disabled" ? "enable" : "disable" }),
    });
    load();
  }

  async function remove(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    load();
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-6 backdrop-blur">
      <h2 className="mb-1 text-lg font-bold text-cyan-300">🔑 مدير المفاتيح</h2>
      <p className="mb-4 text-xs leading-relaxed text-slate-400">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      <form onSubmit={addKey} className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-[170px_1fr_1fr_auto]">
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-400/50"
          aria-label="المزود"
        >
          <option value="kie">kie.ai</option>
          <option value="cometapi">CometAPI</option>
        </select>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="تسمية اختيارية (مثال: حساب 1)"
          className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
          aria-label="تسمية المفتاح"
        />
        <input
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="الصق مفتاح API هنا"
          type="password"
          autoComplete="off"
          className="rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-cyan-400/50"
          aria-label="مفتاح API"
        />
        <button
          type="submit"
          disabled={busy || !apiKey.trim()}
          className="rounded-lg bg-gradient-to-l from-cyan-500 to-purple-500 px-5 py-2 text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "…" : "إضافة"}
        </button>
      </form>

      {msg && (
        <p className={`mb-4 rounded-lg px-3 py-2 text-xs ${msg.kind === "ok" ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"}`}>
          {msg.text}
        </p>
      )}

      <div className="mg-scroll max-h-96 overflow-y-auto rounded-xl border border-white/5">
        {keys.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح لتشتغل المهام</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {keys.map((k, i) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 p-3.5 text-sm">
                <span className="w-6 text-center text-xs text-slate-500">{i + 1}</span>
                <span className="rounded-md border border-white/10 bg-slate-900 px-2 py-0.5 text-xs font-bold text-sky-300">
                  {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                </span>
                <code dir="ltr" className="font-mono text-xs text-slate-300">{k.masked}</code>
                {k.label && <span className="text-xs text-slate-400">«{k.label}»</span>}
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-bold ${STATUS_STYLE[k.status].cls}`}>
                  {STATUS_STYLE[k.status].text}
                </span>
                <span className="text-[11px] text-slate-500">
                  استخدام {k.usage_count} · نجاح {k.success_count} · فشل {k.fail_count}
                </span>
                {k.last_error && (
                  <span className="max-w-full truncate text-[11px] text-rose-400/80" title={k.last_error}>
                    آخر خطأ: {k.last_error.slice(0, 60)}
                  </span>
                )}
                <span className="ms-auto flex gap-2">
                  <button
                    onClick={() => toggle(k)}
                    className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-slate-300 transition hover:bg-white/10"
                  >
                    {k.status === "disabled" ? "تنشيط" : "تعطيل"}
                  </button>
                  <button
                    onClick={() => remove(k)}
                    className="rounded-md border border-rose-500/30 px-2.5 py-1 text-xs text-rose-300 transition hover:bg-rose-500/15"
                  >
                    حذف
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
