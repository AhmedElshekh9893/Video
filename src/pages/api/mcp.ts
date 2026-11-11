// خادم MCP على المسار /mcp — بروتوكول Streamable HTTP عبر الـ SDK الرسمي
// (McpServer + StreamableHTTPServerTransport — بلا JSON-RPC يدوي)
//
// لماذا pages/api؟ لأن App Router لا يكشف Node req/res الأصلي، والـ SDK الرسمي
// مصمم عليهما. هذا هو النمط الموثّق حرفيًا في أمثلة الـ SDK (نفس نمط Express).
// إعادة التوجيه من /mcp إلى /api/mcp تتم في next.config.ts، فالرابط العام يبقى /mcp.
//
// وضع بلا جلسات (sessionIdGenerator: undefined) — القرار المناسب لبيئات Serverless
// مثل Vercel حيث لا تضمن الذاكرة بين الاستدعاءات؛ كل رسالة JSON-RPC مستقلة تمامًا.
import type { NextApiRequest, NextApiResponse } from "next";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SERVER_INFO, SERVER_INSTRUCTIONS, registerTools } from "@/lib/mcp-tools";

export const config = {
  api: { bodyParser: false }, // نقرأ الجسم الخام بأنفسنا ونمرره محللًا
  maxDuration: 300, // نافذة انتظار التوليد قد تمتد دقائق (Fluid compute)
};

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, mcp-session-id, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

function readRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  // توثيق اختياري: إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
  const required = process.env.MCP_ACCESS_TOKEN;
  if (required) {
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${required}`) {
      res.status(401).json({
        jsonrpc: "2.0",
        error: { code: -32001, message: "Unauthorized — مطلوب Authorization: Bearer <MCP_ACCESS_TOKEN>" },
        id: null,
      });
      return;
    }
  }

  // نسخة جديدة لكل طلب (وضع بلا جلسات) — عزل كامل بين الطلبات
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: false, // SSE دائمًا لتمكين بث إشعارات التقدم
  });
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);

  try {
    await server.connect(transport);

    let parsedBody: unknown;
    if (req.method === "POST") {
      const raw = await readRawBody(req);
      try {
        parsedBody = JSON.parse(raw.toString("utf8"));
      } catch {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error — الجسم ليس JSON صالحًا" },
          id: null,
        });
        return;
      }
    }

    await transport.handleRequest(req as never, res as never, parsedBody);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal error: ${(e as Error)?.message ?? e}` },
        id: null,
      });
    }
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
