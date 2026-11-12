/**
 * GET /api/slideshow/[id]/video — بث الفيديو الناتج من صفوف Turso (2MB لكل صف)
 * ============================================================
 * - دعم كامل لـ Range: bytes=N-M و bytes=N- و bytes=-N ⇒ 206 Partia Content.
 * - ?download=1 يضيف Content-Disposition: attachment.
 * - CORS مفتوح حتى يعمل التشغيل من أي عميل خارجي.
 */
import { getSsJob, SS_CHUNK_SIZE } from "@/lib/slideshow/jobs";
import { getTurso } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function outputTotalSize(jobId: string): Promise<number> {
  const r = await getTurso().execute({
    sql: `SELECT SUM(length(data)) AS total, COUNT(*) AS n FROM ss_output_chunks WHERE job_id = ?`,
    args: [jobId],
  });
  const row = r.rows[0] || {};
  const n = Number(row.n || 0);
  const total = Number(row.total || 0);
  // SUM قد يتجاوز دقة JS على الملفات الضخمة — لا يهم هنا (الحد 150MB)
  return n ? total : 0;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getSsJob(id);
  if (!job) {
    return Response.json({ error: "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)" }, { status: 404 });
  }
  if (job.status !== "done") {
    return Response.json(
      { error: `الفيديو غير جاهز بعد (الحالة: ${job.status}، التقدم: ${job.progress}%)` },
      { status: job.status === "failed" ? 409 : 425 }
    );
  }

  const total = await outputTotalSize(id);
  if (!total) {
    return Response.json({ error: "الناتج مفقود من التخزين — أنشئ مهمة جديدة" }, { status: 404 });
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  const headers = new Headers({
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  if (download) headers.set("Content-Disposition", `attachment; filename="narrated-video-${id.slice(0, 8)}.mp4"`);

  // تحليل المدى المطلوب
  let start = 0;
  let end = total - 1;
  let status = 200;
  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (!m[1] && !m[2])) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    if (!m[1] && m[2]) {
      // bytes=-N — آخر N بايت
      const n = Math.min(Number(m[2]), total);
      start = total - n;
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    }
    if (start > end || start >= total) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    status = start > 0 || end < total - 1 ? 206 : 200;
    headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
  }
  headers.set("Content-Length", String(end - start + 1));

  const chunkSize = SS_CHUNK_SIZE;
  const firstChunk = Math.floor(start / chunkSize);
  const lastChunk = Math.floor(end / chunkSize);

  let nextChunk = firstChunk;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (nextChunk > lastChunk) {
        controller.close();
        return;
      }
      const c = nextChunk++;
      const r = await getTurso().execute({
        sql: `SELECT data FROM ss_output_chunks WHERE job_id = ? AND chunk = ?`,
        args: [id, c],
      });
      if (!r.rows.length) {
        controller.close();
        return;
      }
      let buf = Buffer.isBuffer(r.rows[0].data) ? r.rows[0].data : Buffer.from(r.rows[0].data as unknown as ArrayBuffer);
      const pos = c * chunkSize;
      const chunkEnd = pos + buf.length - 1;
      let sliceStart = 0;
      let sliceEnd = buf.length - 1;
      if (start > pos) sliceStart = start - pos;
      if (end < chunkEnd) sliceEnd = end - pos;
      if (sliceStart <= sliceEnd) {
        controller.enqueue(new Uint8Array(buf.subarray(sliceStart, sliceEnd + 1)));
      }
    },
  });

  return new Response(stream, { status, headers });
}
