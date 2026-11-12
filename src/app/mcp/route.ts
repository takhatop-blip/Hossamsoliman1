/**
 * خادم MCP — المسار /mcp (نقل Streamable HTTP حسب مواصفات MCP)
 * ============================================================
 * - يستخدم SDK الرسمي فقط: McpServer + StreamableHTTPServerTransport (لا JSON-RPC يدوي).
 * - استجابات الأدوات تُصاغ بالعربية، أما أوصاف الأدوات فبالإنجليزية الدقيقة (يقرأها العميل).
 * - إدارة الجلسات: خريطة بالذاكرة + «إحياء» شفاف لأي جلسة غير معروفة (بعد إعادة تدوير
 *   الذاكرة في serverless) بحيث تُهيأ داخليًا بنفس mcp-session-id دون أن يشعر العميل.
 * - حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN فمطلوب Authorization: Bearer <token>.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { formatTaskForClient, refreshTask, runGeneration, runMerge } from "@/lib/orchestrator";
import { resolveModel, MODELS } from "@/lib/models";
import { listRecentTasks, type TaskRow } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

export const SERVER_INSTRUCTIONS =
  `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

/* ---------------- إدارة الجلسات بالذاكرة ---------------- */

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}
const sessions = new Map<string, Session>();
const MAX_SESSIONS = 200;

function touchSession(id: string): void {
  const s = sessions.get(id);
  if (s) {
    s.lastSeen = Date.now();
    sessions.delete(id);
    sessions.set(id, s);
  }
  // إخلاء الأقدم عند التجاوز
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

/** بناء خادم جديد بالأدوات الخمس مسجلة */
function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  const progressTokenOf = (extra: unknown): string | number | undefined => {
    const ex = extra as { requestInfo?: { _meta?: { progressToken?: string | number } }; _meta?: { progressToken?: string | number } };
    return ex?.requestInfo?._meta?.progressToken ?? ex?._meta?.progressToken;
  };
  const makeProgressCb = (extra: unknown) => {
    const token = progressTokenOf(extra);
    const ex = extra as { sendNotification?: (n: unknown) => Promise<void> };
    if (!token || typeof ex?.sendNotification !== "function") return undefined;
    return async (progress: number, message: string) => {
      try {
        await ex.sendNotification!({
          method: "notifications/progress",
          params: { progressToken: token, progress, total: 100, message },
        });
      } catch {
        /* العميل قد يكون فصل — نتجاهل */
      }
    };
  };

  /* ---------- 1) generate_image ---------- */
  server.registerTool(
    "generate_image",
    {
      title: "Generate Image",
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). " +
        "Returns a ready image URL if generation finishes within the wait window; otherwise returns a task_id — " +
        "then call get_task every ~10 seconds until completed, show the URL and stop.",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z
          .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .optional()
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z
          .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .optional()
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).optional().default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).optional().default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).optional().default("png"),
        wait_seconds: z.number().int().min(0).max(240).optional().default(90),
      },
    },
    async (args, extra) => {
      const model = resolveModel(args.model);
      if (!model) {
        return err(`❌ موديل غير معروف: ${args.model}. المتاح: ${MODELS.map((m) => m.canonical).join(", ")}`);
      }
      const task = await runGeneration({
        model,
        params: args,
        wait_seconds: args.wait_seconds,
        onProgress: makeProgressCb(extra),
      });
      const failed = task.status === "failed";
      return {
        content: [{ type: "text", text: formatTaskForClient(task) }],
        isError: failed,
      };
    }
  );

  /* ---------- 2) generate_video ---------- */
  server.registerTool(
    "generate_video",
    {
      title: "Generate Video",
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue in the prompt is spoken; " +
        "optional image-to-video). Video takes minutes: short wait with live progress, then a task_id is returned — " +
        "follow it with get_task every ~10 seconds until completed, then show the URL.",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z
          .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .optional()
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).optional().default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).optional().default("480p"),
        enable_audio: z.boolean().optional().default(true),
        duration: z.number().int().min(1).max(15).optional().default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).optional().default(25),
      },
    },
    async (args, extra) => {
      const model = resolveModel(args.model);
      if (!model) {
        return err(`❌ موديل غير معروف: ${args.model}. المتاح: ${MODELS.map((m) => m.canonical).join(", ")}`);
      }
      const task = await runGeneration({
        model,
        params: args,
        wait_seconds: args.wait_seconds,
        onProgress: makeProgressCb(extra),
      });
      const failed = task.status === "failed";
      return {
        content: [{ type: "text", text: formatTaskForClient(task) }],
        isError: failed,
      };
    }
  );

  /* ---------- 3) merge_videos ---------- */
  server.registerTool(
    "merge_videos",
    {
      title: "Merge Videos",
      description:
        "Merge several clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — " +
        "like the ones returned by generate_video) or 'task_ids' (COMPLETED video tasks; their result URLs are merged " +
        "in this order — ideal right after generating several clips). Merging is usually fast: short wait with live " +
        "progress, then a merge task_id — track it with get_task. " +
        "NOTE: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z
          .array(z.string())
          .min(2, "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.")
          .max(10, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).")
          .optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).optional().default(60),
      },
    },
    async (args, extra) => {
      const outcome = await runMerge({
        urls: args.urls,
        task_ids: args.task_ids,
        wait_seconds: args.wait_seconds,
        onProgress: makeProgressCb(extra),
      });
      if (outcome.error || !outcome.task) {
        return err(outcome.error || "فُقد سجل المهمة من قاعدة البيانات — أعد المحاولة.");
      }
      const task = outcome.task;
      return {
        content: [{ type: "text", text: formatTaskForClient(task) }],
        isError: task.status === "failed",
      };
    }
  );

  /* ---------- 4) get_task ---------- */
  server.registerTool(
    "get_task",
    {
      title: "Get Task",
      description:
        "Track any task by its id — image/video generation AND merging (reads the Turso database and refreshes live " +
        "from the provider/merging service while processing). Poll every ~10 seconds; when completed you will find the " +
        "result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().describe("The task_id returned by generate_image / generate_video / merge_videos."),
      },
    },
    async (args) => {
      const task = await refreshTask(args.task_id.trim());
      if (!task) {
        return err(`❌ لم يتم العثور على مهمة بالمعرف: ${args.task_id}`);
      }
      return {
        content: [{ type: "text", text: formatTaskForClient(task) }],
        isError: task.status === "failed",
      };
    }
  );

  /* ---------- 5) list_media ---------- */
  server.registerTool(
    "list_media",
    {
      title: "List Media",
      description:
        "Latest images / videos / merges stored with their URLs from the database (no regeneration) — " +
        "recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).optional().default(10),
      },
    },
    async (args) => {
      const status = args.status === "processing" ? undefined : args.status;
      let tasks: TaskRow[] = await listRecentTasks(args.limit ?? 10, {
        type: args.type,
        status,
      });
      if (args.status === "processing") {
        tasks = tasks.filter((t) => t.status === "pending" || t.status === "processing");
      }
      if (!tasks.length) {
        return { content: [{ type: "text", text: "لا توجد وسائط مخزنة مطابقة لهذا الفلتر بعد." }] };
      }
      const lines: string[] = [`أحدث ${tasks.length} وسيطًا مخزنًا (من الأحدث إلى الأقدم):`, ""];
      tasks.forEach((t, i) => {
        let urls: string[] = [];
        try {
          urls = t.result_urls_json ? (JSON.parse(t.result_urls_json) as string[]) : [];
        } catch {
          urls = [];
        }
        const kind = t.type === "image" ? "🖼️ صورة" : t.type === "video" ? "🎬 فيديو" : "🎞️ دمج";
        const state =
          t.status === "completed" ? "✅ مكتملة" : t.status === "failed" ? "❌ فاشلة" : "⏳ جارية";
        lines.push(`${i + 1}) ${kind} | ${state} | الموديل: ${t.model}`);
        lines.push(`   task_id: ${t.id} | أُنشئت: ${t.created_at}`);
        if (t.prompt) lines.push(`   الوصف: ${t.prompt.slice(0, 120)}${t.prompt.length > 120 ? "…" : ""}`);
        for (const u of urls) lines.push(`   الرابط: ${u}`);
        if (t.status === "failed" && t.error_message) lines.push(`   السبب: ${t.error_message}`);
        lines.push("");
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  return server;
}

function err(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/** إنشاء زوج server+transport جديد (بلا تسجيل جلسة — يُسجَّل عند initialize فقط) */
function freshPair(clientSessionId?: string): { server: McpServer; transport: WebStandardStreamableHTTPServerTransport } {
  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // مولّد معرّف الجلسة: نحافظ على معرّف العميل عند الإحياء لتبقى الجلسة متوافقة
    sessionIdGenerator: clientSessionId ? () => clientSessionId : () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport, lastSeen: Date.now() });
    },
  });
  void server.connect(transport);
  return { server, transport };
}

/** نداء داخلي مُهمل الاستجابة — يُستخدم لإحياء الجلسات بعد إعادة تدوير الذاكرة */
async function discardCall(
  transport: WebStandardStreamableHTTPServerTransport,
  body: string,
  sessionId?: string
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  try {
    const res = await transport.handleRequest(
      new Request("http://internal/mcp", { method: "POST", headers, body: body || undefined })
    );
    // نستنزف الجسم حتى تُغلق قناة SSE الداخلية
    await res.text();
  } catch {
    /* مقصود — نداء داخلي */
  }
}

function initBodyTemplate(): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "session-revival", version: "1.0" },
    },
  });
}

async function handleRequest(webReq: Request): Promise<Response> {
  // حماية اختيارية بـ Bearer token
  const required = process.env.MCP_ACCESS_TOKEN?.trim();
  if (required) {
    const auth = webReq.headers.get("authorization") || "";
    if (auth !== `Bearer ${required}`) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized: مطلوب Authorization: Bearer <token>" }, id: null },
        { status: 401 }
      );
    }
  }

  const clientSessionId = webReq.headers.get("mcp-session-id") || undefined;
  let bodyJson: { method?: string } | null = null;
  if (webReq.method === "POST") {
    try {
      bodyJson = (await webReq.clone().json()) as { method?: string };
    } catch {
      bodyJson = null;
    }
  }

  const isInitialize = bodyJson?.method === "initialize";
  let pair = clientSessionId ? sessions.get(clientSessionId) : undefined;
  if (pair) touchSession(clientSessionId!);

  if (!pair) {
    if (isInitialize) {
      // جلسة جديدة حقيقية
      pair = freshPair();
    } else if (webReq.method === "POST") {
      // إحياء شفاف: جلسة غير معروفة (أُعيدت دورة الذاكرة في serverless) —
      // نُهيّئ الخادم داخليًا بنفس mcp-session-id فيشعر العميل بأن شيئًا لم يحدث
      pair = freshPair(clientSessionId ?? randomUUID());
      await discardCall(pair.transport, initBodyTemplate(), clientSessionId);
      await discardCall(
        pair.transport,
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        clientSessionId
      );
    } else if (webReq.method === "DELETE") {
      // إنهاء جلسة غير موجودة — نرد نجاحًا صامتًا
      return new Response(null, { status: 200 });
    } else {
      // GET لجلسة غير معروفة: نحييها ثم نفتح قناة SSE
      pair = freshPair(clientSessionId ?? randomUUID());
      await discardCall(pair.transport, initBodyTemplate(), clientSessionId);
      await discardCall(
        pair.transport,
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        clientSessionId
      );
    }
  }

  try {
    // النقل القياسي يتعامل مباشرة مع Web Request ويعيد Web Response (يتيح SSE الحي)
    return await pair.transport.handleRequest(webReq);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: `Internal error: ${msg}` }, id: null },
      { status: 500 }
    );
  }
}

export async function POST(req: Request): Promise<Response> {
  return handleRequest(req);
}

export async function GET(req: Request): Promise<Response> {
  // فتح قناة SSE للخادم→العميل (تدعمها SDK) — الجلسة يجب أن تكون معروفة
  return handleRequest(req);
}

export async function DELETE(req: Request): Promise<Response> {
  // إنهاء الجلسة
  const sid = req.headers.get("mcp-session-id");
  if (sid) sessions.delete(sid);
  return handleRequest(req);
}
