"use client";

// بطاقة ربط السيرفر: رابط /mcp + JSON جاهز للنسخ لكل عميل + رقائق الأدوات
import { useEffect, useMemo, useState } from "react";

const TOOLS: Array<{ name: string; desc: string }> = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي (gpt-image-2-6/flare-text-to-image)" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي (grok-imagine-video-1-5-preview)" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد عالي الجودة بالترتيب المعطى" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال ثم عرض الروابط" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

export default function ConnectCard({ authRequired }: { authRequired: boolean }) {
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<"chatgpt" | "claude" | "cursor">("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = origin ? `${origin}/mcp` : "<رابط-النشر>/mcp";

  const json = useMemo(() => {
    const headers = authRequired ? { Authorization: "Bearer <MCP_ACCESS_TOKEN>" } : undefined;
    if (tab === "claude") {
      return JSON.stringify(
        { mcpServers: { "media-generator": { type: "http", url: mcpUrl, ...(headers ? { headers } : {}) } } },
        null, 2
      );
    }
    if (tab === "cursor") {
      return JSON.stringify(
        { mcpServers: { "media-generator": { url: mcpUrl, ...(headers ? { headers } : {}) } } },
        null, 2
      );
    }
    // ChatGPT / GPT Agents — Connectors: Server URL
    return JSON.stringify({ mcpServers: { "media-generator": { url: mcpUrl, ...(headers ? { headers } : {}) } } }, null, 2);
  }, [tab, mcpUrl, authRequired]);

  async function copy(text: string, tag: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* المتصفح رفض النسخ */
    }
  }

  const tabBtn = (id: typeof tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
        tab === id ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40" : "text-slate-400 border border-transparent hover:bg-white/5"
      }`}
    >
      {label}
    </button>
  );

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:p-6 backdrop-blur">
      <h2 className="mb-4 text-lg font-bold text-sky-300">🔗 ربط السيرفر</h2>

      {/* رابط MCP */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div dir="ltr" className="flex-1 min-w-[260px] truncate rounded-lg border border-white/10 bg-slate-900 px-3 py-2 font-mono text-xs text-cyan-200">
          {mcpUrl}
        </div>
        <button
          onClick={() => copy(mcpUrl, "url")}
          className="rounded-lg bg-gradient-to-l from-cyan-500 to-purple-500 px-4 py-2 text-xs font-bold text-white transition hover:opacity-90"
        >
          {copied === "url" ? "✓ نُسخ" : "نسخ الرابط"}
        </button>
      </div>

      {/* تبويبات JSON */}
      <div className="mb-2 flex flex-wrap gap-2">
        {tabBtn("chatgpt", "ChatGPT / GPT Agents")}
        {tabBtn("claude", "Claude Desktop")}
        {tabBtn("cursor", "Cursor / Windsurf / Cline")}
      </div>
      <pre dir="ltr" className="mg-scroll max-h-44 overflow-auto rounded-xl border border-white/10 bg-slate-900 p-3 text-left font-mono text-[11px] leading-relaxed text-emerald-200">
{json}
      </pre>
      <button
        onClick={() => copy(json, "json")}
        className="mt-2 rounded-md border border-white/10 px-3 py-1 text-xs text-slate-300 transition hover:bg-white/10"
      >
        {copied === "json" ? "✓ نُسخ JSON" : "نسخ JSON"}
      </button>
      {tab === "chatgpt" && (
        <p className="mt-2 text-[11px] text-slate-400">
          في ChatGPT: الإعدادات ← Connectors ← Create ← Custom MCP connector وضع الرابط أعلاه في «Server URL».
        </p>
      )}
      {tab === "claude" && (
        <p className="mt-2 text-[11px] text-slate-400">
          ضع المحتوى في ملف <code dir="ltr">claude_desktop_config.json</code> ثم أعد تشغيل التطبيق.
        </p>
      )}
      {tab === "cursor" && (
        <p className="mt-2 text-[11px] text-slate-400">
          ضع المحتوى في <code dir="ltr">mcp.json</code> لدى Cursor / Windsurf / Cline.
        </p>
      )}

      {/* رقائق الأدوات */}
      <div className="mt-5 flex flex-wrap gap-2">
        {TOOLS.map((t) => (
          <span
            key={t.name}
            className="inline-flex max-w-full items-center gap-2 rounded-full border border-white/10 bg-slate-900/70 px-3 py-1.5 text-[11px]"
            title={t.desc}
          >
            <code dir="ltr" className="font-mono font-bold text-cyan-300">{t.name}</code>
            <span className="truncate text-slate-400">{t.desc}</span>
          </span>
        ))}
      </div>

      {/* ملاحظة كهرمانية */}
      <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/10 p-3.5 text-[12px] leading-relaxed text-amber-200">
        ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابعَه تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف.
        أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
      </div>
    </section>
  );
}
