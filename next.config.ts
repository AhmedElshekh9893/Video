import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: false,
  // نريد فحص أنواع صارمًا — الأخطاء تُظهرها tsc والبناء
  typescript: {
    ignoreBuildErrors: false,
  },
  // حزم أصلية/ثنائيات يجب ألا تُحزَّم بل تُحمَّل من node_modules وقت التشغيل
  serverExternalPackages: ["@libsql/client", "libsql", "ffmpeg-static", "ffprobe-static"],
  // تضمين ثنائيات ffmpeg/ffprobe في دالة المعالجة عند النشر على Vercel
  outputFileTracingIncludes: {
    "/api/jobs/[id]/process": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffprobe-static/bin/**/*",
    ],
  },
  async rewrites() {
    // نقطة MCP الرسمية على جذر المسار /mcp (التنفيذ في pages/api/mcp.ts)
    return [{ source: "/mcp", destination: "/api/mcp" }];
  },
};

export default nextConfig;
