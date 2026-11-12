/**
 * GET /api/config — الحدود العامة + version (يُستخدم لفحص الجهوزية)
 */
const { LIMITS, json } = require("../lib/utils");

module.exports = async (req, res) => {
  return json(res, 200, {
    version: "1.1.0",
    service: "video-merger-api",
    limits: {
      maxSources: LIMITS.MAX_SOURCES,
      sourceMaxMB: LIMITS.SOURCE_MAX_MB,
      outputMaxMB: LIMITS.OUTPUT_MAX_MB,
      maxTotalDurationSec: LIMITS.MAX_TOTAL_DURATION_SEC,
      uploadChunkBytes: LIMITS.UPLOAD_CHUNK_BYTES,
      retentionHours: LIMITS.RETENTION_HOURS,
      output: "MP4 (H.264 + AAC) حتى 1080p بجودة CRF 18 — لا توجد معاملات resolution/fps",
      slideshow: "صور + تعليق صوتي لراوي (TTS مجاني) — حتى 20 صورة، 480p/720p/1080p",
    },
    endpoints: [
      "POST /api/jobs",
      "POST /api/upload?job=<id>&seq=<n>&chunk=<k>",
      "POST /api/jobs/<id>/process",
      "GET /api/jobs/<id>",
      "GET /api/jobs/<id>/video",
      "POST /api/slideshow",
      "POST /api/slideshow/<id>/process",
      "GET /api/slideshow/<id>",
      "DELETE /api/jobs/<id>",
      "GET /api/config",
      "GET /api/cron",
    ],
  });
};
