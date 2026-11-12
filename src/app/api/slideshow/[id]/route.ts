/**
 * GET /api/slideshow/[id] — حالة مهمة تعليق مصوّر (للتشخيص والتتبع)
 * المنسّق يقرأ الحالة من قاعدة البيانات مباشرة؛ هذا المسار للفحص اليدوي.
 */
import { getSsJob } from "@/lib/slideshow/jobs";
import { slideshowResultBase } from "@/lib/slideshow/base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getSsJob(id);
  if (!job) {
    return Response.json({ error: "مهمة التعليق المصوّر غير موجودة (حُذفت أو انتهت صلاحيتها)" }, { status: 404 });
  }
  const out: Record<string, unknown> = {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    error: job.error ?? undefined,
    expiresAt: job.expires_at ?? undefined,
  };
  if (job.status === "done") {
    const base = slideshowResultBase(req);
    out.videoUrl = job.result_url || `${base}/api/slideshow/${id}/video`;
    out.downloadUrl = `${out.videoUrl}?download=1`;
    out.size = job.result_size ?? 0;
    out.duration = job.result_duration ?? 0;
    out.resolution = job.result_resolution ?? undefined;
  }
  return Response.json(out);
}
