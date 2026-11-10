/**
 * GET /api/tasks — أحدث المهام + الإحصائيات (تستهلكها لوحة المهام كل ~5 ثوانٍ)
 * أمثلة: /api/tasks?limit=20 | ?type=video | ?status=completed
 */
import { listRecentTasks, taskStats, type TaskStatus, type TaskType } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 20) || 20));
    const type = (url.searchParams.get("type") || undefined) as TaskType | undefined;
    const status = (url.searchParams.get("status") || undefined) as TaskStatus | undefined;

    const [tasks, stats] = await Promise.all([
      listRecentTasks(limit, {
        type: type && ["image", "video", "merge"].includes(type) ? type : undefined,
        status: status && ["pending", "processing", "completed", "failed"].includes(status) ? status : undefined,
      }),
      taskStats(),
    ]);

    return Response.json({
      stats,
      tasks: tasks.map((t) => {
        let urls: string[] = [];
        try {
          urls = t.result_urls_json ? (JSON.parse(t.result_urls_json) as string[]) : [];
        } catch {
          urls = [];
        }
        let attempts: unknown[] = [];
        try {
          attempts = JSON.parse(t.attempts_json || "[]");
        } catch {
          attempts = [];
        }
        return {
          id: t.id,
          type: t.type,
          model: t.model,
          provider: t.provider,
          status: t.status,
          progress: t.progress,
          prompt: t.prompt,
          urls,
          error_message: t.error_message,
          attempts_count: attempts.length,
          created_at: t.created_at,
          completed_at: t.completed_at,
        };
      }),
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير معروف" }, { status: 500 });
  }
}
