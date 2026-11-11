// إعدادات وحدود خدمة الدمج الداخلية — كلها قابلة للضبط بمتغيرات البيئة
const MB = 1024 * 1024;

function num(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
}

export const MERGE_LIMITS = {
  // أقصى عدد مقاطع في مهمة دمج واحدة (حد صارم من خدمة الدمج)
  maxSources: 10,
  // أقصى حجم لكل مصدر (يُفحص أثناء التنزيل بالبايت)
  sourceMaxBytes: num("SOURCE_MAX_MB", 200) * MB,
  // أقصى حجم للناتج النهائي
  outputMaxBytes: num("OUTPUT_MAX_MB", 150) * MB,
  // أقصى مجموع لمدد المقاطع بالثواني
  maxTotalDurationSec: num("MAX_TOTAL_DURATION_SEC", 600),
  // حجم جزء الرفع من الواجهة (حد طلب Vercel ≈ 4.5MB)
  uploadChunkBytes: num("UPLOAD_CHUNK_BYTES", 4) * MB,
  // كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso)
  blobChunkBytes: 2 * MB,
  // عدد صفوف Blobs المقروءة في كل صفحة أثناء البث
  blobPageRows: num("BLOB_PAGE_ROWS", 4),
  // كل الملفات تُحذف تلقائيًا بعد 24 ساعة
  retentionHours: 24,
  // مهلة تنزيل كل مصدر بالثواني
  downloadTimeoutSec: num("DOWNLOAD_TIMEOUT_SEC", 180),
} as const;

export const MERGER_VERSION = "2.0.0";
export const MERGE_MODEL = "video-merger";

// إن ضُبط MERGER_API_BASE نستخدم خدمة دمج خارجية عبر HTTP،
// وإلا فالتطبيق يستضيف خدمة الدمج داخليًا (نفس عملية النشر) — الأنسب لـ Vercel
export function mergerExternalBase(): string | null {
  const b = process.env.MERGER_API_BASE?.trim();
  return b ? b.replace(/\/+$/, "") : null;
}

export function isInternalMerger(): boolean {
  return mergerExternalBase() === null;
}

// الرابط المطلق للتطبيق (يُستخدم لبناء روابط النتائج الداخلية)
export function appOrigin(headers: Headers): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (prod) return `https://${prod}`;
  const proto = headers.get("x-forwarded-proto") || "http";
  const host = headers.get("x-forwarded-host") || headers.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}
