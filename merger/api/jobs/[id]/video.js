/**
 * GET /api/jobs/{id}/video — بث الناتج بدعم Range (206 + Content-Range)
 * ?download=1 للتحميل المباشر (Content-Disposition attachment)
 */
const db = require("../../../lib/db");
const { fail } = require("../../../lib/utils");

module.exports = async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "طريقة غير مسموحة — استخدم GET");
  const { id } = req.query;
  if (!id) return fail(res, 400, "معرف المهمة مطلوب");

  const job = await db.getJob(id);
  if (!job) return fail(res, 404, "المهمة غير موجودة (حُذفت أو انتهت صلاحيتها)");
  if (job.status !== "done") {
    return fail(res, 409, `الناتج غير جاهز — حالة المهمة: ${job.status}`);
  }

  const { total } = await db.getOutputSize(id);
  if (!total) return fail(res, 404, "الناتج غير موجود في التخزين");

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", String(total));
    res.setHeader("Accept-Ranges", "bytes");
    return res.end();
  }

  // تحليل رأس Range — يدعم التقديم/الترجيع في المشغل
  const rangeHeader = req.headers.range;
  const download = req.query.download === "1" || req.query.download === "true";
  let start = 0;
  let end = total - 1;
  if (rangeHeader) {
    const m = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
    if (!m) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.end();
    }
    if (m[1] === "" && m[2] !== "") {
      // لاحقة: آخر N بايت
      const n = Math.min(Number(m[2]), total);
      start = total - n;
      end = total - 1;
    } else {
      start = Number(m[1]);
      if (m[2] !== "") end = Math.min(Number(m[2]), total - 1);
      else end = total - 1;
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${total}`);
      return res.end();
    }
  }

  await db.streamOutput(res, id, { start, end, totalSize: total, download });
};
