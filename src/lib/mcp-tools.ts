// تسجيل أدوات MCP الخمس — المخططات الإنجليزية للعميل، والردود العربية للعرض
import { z } from "zod";
import { runGeneration, refreshTask, listMedia } from "./generation";
import type { ProgressNotifier, ToolReply } from "./generation";
import { runMerge } from "./merge";
import { modelEnum } from "./models";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// بناء مرسل التقدم الحي من _meta.progressToken إن وفره العميل
function notifierFromExtra(extra: RequestHandlerExtra<any, any> | undefined): ProgressNotifier | null {
  const token = (extra?._meta as { progressToken?: unknown } | undefined)?.progressToken;
  if (!token || typeof extra?.sendNotification !== "function") return null;
  return {
    async sendProgress(progress: number, total: number, message: string) {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    },
  };
}

type ToolArgs = Record<string, unknown>;

// غلاف موحد: كل رسائل الأدوات عربية، والأخطاء الداخلية تُنظَّف قبل الخروج
async function safe(
  fn: () => Promise<ToolReply>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const r = await fn();
    return { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) };
  } catch (e) {
    const msg = (e as Error)?.message ?? "خطأ داخلي غير متوقع";
    return { content: [{ type: "text", text: `❌ فشلت المهمة: ${msg}` }], isError: true };
  }
}

export function registerTools(server: McpServer): void {
  // ─── 1) generate_image ───
  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active API keys). " +
        "Returns the finished image URL if it completes within the wait window, otherwise returns a task_id — call get_task with it every ~10 seconds until completed, then show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(modelEnum("image") as [string, ...string[]])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args: ToolArgs, extra) =>
      safe(() => runGeneration("image", args, notifierFromExtra(extra)))
  );

  // ─── 2) generate_video ───
  server.registerTool(
    "generate_video",
    {
      title: "Generate video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). " +
        "Videos take minutes: expect a short wait with live progress streaming, then a task_id — track it with get_task every ~10 seconds.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(modelEnum("video") as [string, ...string[]])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args: ToolArgs, extra) =>
      safe(() => runGeneration("video", args, notifierFromExtra(extra)))
  );

  // ─── 3) merge_videos ───
  server.registerTool(
    "merge_videos",
    {
      title: "Merge videos",
      description:
        "Merge several clips into ONE final high-quality video in the given order. Pass 'urls' (public direct video links) or " +
        "'task_ids' (COMPLETED video generation tasks — their result URLs are resolved from the database in this order; ideal after generating several clips). " +
        "Merging is usually fast: short wait with live progress, then a merge task_id — track it with get_task. " +
        "Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string()).min(2).max(10).optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string()).min(2).max(10).optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args: ToolArgs, extra) => safe(() => runMerge(args, notifierFromExtra(extra)))
  );

  // ─── 4) get_task ───
  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/merging service while processing). " +
        "Poll it every ~10 seconds; when completed you'll find the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args: ToolArgs, extra) => safe(() => refreshTask(String(args.task_id), notifierFromExtra(extra)))
  );

  // ─── 5) list_media ───
  server.registerTool(
    "list_media",
    {
      title: "List media",
      description:
        "Latest stored images/videos/merges with their result URLs from the database (no regeneration) — recall previous results.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args: ToolArgs) => safe(() => listMedia(args))
  );
}
