// سجل الموديلات — الأسماء الأساسية والبدائل والمزودون الذين يخدمون كل موديل
export type ProviderId = "kie" | "cometapi";
export type MediaType = "image" | "video";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحّدها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // تُجرَّب مفاتيح كل المزودين بالترتيب التسلسلي
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسَل لكل مزود
}

// الأسماء قابلة للتجاوز بمتغيرات البيئة (KIE_IMAGE_MODEL، COMETAPI_VIDEO_MODEL …)
// ملاحظة: أسماء CometAPI مأخوذة من كتالوجهم الرسمي الحقيقي (GET /api/models)
// ووثائق نقطة grok/v1/videos/generations — وليست اختراعًا.
const KIE_IMAGE = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
const COMETAPI_IMAGE = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.5-flare";
const COMETAPI_VIDEO = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video-1.5";

export const MODELS: ModelDef[] = [
  {
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2.6/flare-text-to-image", "gpt-image-2-6-flare-text-to-image"],
    type: "image",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_IMAGE, cometapi: COMETAPI_IMAGE },
  },
  {
    canonical: "grok-imagine-video-1-5-preview",
    aliases: ["grok-imagine-video-1.5-preview", "grok-imagine-video-1-5"],
    type: "video",
    providers: ["kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO, cometapi: COMETAPI_VIDEO },
  },
];

// توحيد الاسم: نقبل الشرطات والنقاط بالتبادل (2.6 ↔ 2-6)
function normalize(name: string): string {
  return name.trim().replace(/\./g, "-").toLowerCase();
}

export function resolveModel(name: string | undefined | null): ModelDef | null {
  if (!name) return null;
  const target = normalize(name);
  for (const m of MODELS) {
    if (normalize(m.canonical) === target) return m;
    if (m.aliases.some((a) => normalize(a) === target)) return m;
  }
  return null;
}

export function defaultModelFor(type: MediaType): string {
  return type === "image" ? MODELS[0].canonical : MODELS[1].canonical;
}

// قائمة أسماء الموديل المقبولة في مخطط الأداة (canonical + aliases)
export function modelEnum(type: MediaType): string[] {
  return MODELS.filter((m) => m.type === type).flatMap((m) => [m.canonical, ...m.aliases]);
}
