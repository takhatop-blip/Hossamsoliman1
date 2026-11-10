/**
 * GET /api/config — الحدود العامة + version (يُستخدم لفحص الجهوزية)
 */
const { LIMITS, json } = require("../lib/utils");

module.exports = async (req, res) => {
  return json(res, 200, {
    version: "1.0.0",
    service: "video-merger-api",
    limits: {
      maxSources: LIMITS.MAX_SOURCES,
      sourceMaxMB: LIMITS.SOURCE_MAX_MB,
      outputMaxMB: LIMITS.OUTPUT_MAX_MB,
      maxTotalDurationSec: LIMITS.MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: LIMITS.UPLOAD_CHUNK_BYTES,
      retentionHours: LIMITS.RETENTION_HOURS,
      output: "MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — لا توجد معاملات resolution/fps",
    },
    endpoints: [
      "POST /api/jobs",
      "POST /api/upload?job=<id>&seq=<n>&chunk=<k>",
      "POST /api/jobs/<id>/process",
      "GET /api/jobs/<id>",
      "GET /api/jobs/<id>/video",
      "DELETE /api/jobs/<id>",
      "GET /api/config",
      "GET /api/cron",
    ],
  });
};
