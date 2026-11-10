/**
 * GET /api/cron — حذف المهام المنتهية صلاحيتها (Cron يومي في vercel.json)
 * كل الملفات تُحذف تلقائيًا بعد 24 ساعة من انتهائها.
 */
const db = require("../lib/db");
const { json, fail } = require("../lib/utils");

module.exports = async (req, res) => {
  if (req.method !== "GET" && req.method !== "POST") return fail(res, 405, "طريقة غير مسموحة");
  try {
    const deleted = await db.cleanupExpired();
    return json(res, 200, { ok: true, deletedJobs: deleted, at: new Date().toISOString() });
  } catch (e) {
    return fail(res, 500, e.message || "فشل التنظيف");
  }
};
