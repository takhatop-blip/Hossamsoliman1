/**
 * مزود CometAPI (المزود الثاني)
 * ============================================================
 * الأشكال مأخوذة من التوثيق الرسمي apidoc.cometapi.com:
 *  - الصور (متزامنة): POST /v1/images/generations — متوافق مع OpenAI، يعيد
 *    {"data":[{"url"|"b64_json"}]} فورًا. نطلب response_format:"url" وإن أعاد
 *    b64_json بلا رابط نعتبرها فشل «provider» (لا ننزل أي وسائط على سيرفرنا إطلاقًا).
 *  - الفيديو (غير متزامن، مسار xAI/Grok):
 *    POST /grok/v1/videos/generations → {"request_id":"..."}
 *    GET  /grok/v1/videos/{request_id} → {"status":"done|failed|expired","video":{"url"}}
 *
 * ملاحظة موثقة: كتالوج CometAPI الحي (GET /api/models) يُعرّف موديل الفيديو الرسمي
 * باسم "grok-imagine-video" (وأيضًا grok-imagine-video-1.5 في جدول الأسعار) — نتبع
 * الكتالوج حسب القاعدة الذهبية رقم 10، مع إمكانية التجاوز بمتغير البيئة COMETAPI_VIDEO_MODEL.
 */
import { classifyProviderError, makeProviderError } from "../keys";
import {
  extractErrorMessage,
  fetchJsonWithTimeout,
  type ProviderAdapter,
  type ProviderImageInput,
  type ProviderKeyRef,
  type ProviderVideoInput,
  type TaskCheckResult,
} from "./types";

const BASE = process.env.COMETAPI_API_BASE?.trim() || "https://api.cometapi.com";

interface AnyBody {
  [k: string]: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** يرمي ProviderError مصنّفًا عند أخطاء HTTP */
function assertHttpOk(httpStatus: number, body: unknown, fallback: string): void {
  if (httpStatus >= 400) {
    const msg = extractErrorMessage(body, `HTTP ${httpStatus}: ${fallback}`);
    throw makeProviderError(httpStatus, msg, classifyProviderError(httpStatus, msg));
  }
}

/** تحويل نسبة الأبعاد إلى أحجام OpenAI المعتمدة للصور (موثقة رسميًا) */
function aspectToSize(ar?: string): string | undefined {
  switch (ar) {
    case "1:1":
    case "auto":
      return "1024x1024";
    case "3:2":
    case "4:3":
    case "5:4":
    case "16:9":
    case "2:1":
    case "21:9":
    case "3:1":
      return "1536x1024";
    case "2:3":
    case "3:4":
    case "4:5":
    case "9:16":
    case "1:2":
    case "9:21":
    case "1:3":
      return "1024x1536";
    default:
      return undefined;
  }
}

export const cometapiAdapter: ProviderAdapter = {
  /** صور متزامنة — CometAPI يعيد الرابط فورًا عبر نقطة OpenAI images */
  async createImageSync(
    key: ProviderKeyRef,
    providerModel: string,
    input: ProviderImageInput
  ): Promise<{ urls: string[] }> {
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt: input.prompt,
      response_format: "url", // نريد روابط — لا باينري على سيرفرنا أبدًا
      n: 1,
    };
    const size = aspectToSize(input.aspect_ratio);
    if (size) payload.size = size;

    const { httpStatus, body } = await fetchJsonWithTimeout(
      `${BASE}/v1/images/generations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.api_key}` },
        body: JSON.stringify(payload),
      },
      120_000 // توليد الصور المتزامن قد يأخذ وقتًا
    );
    assertHttpOk(httpStatus, body, "cometapi images failed");

    const data = asRecord(body).data;
    const items = Array.isArray(data) ? data.map(asRecord) : [];
    const urls: string[] = [];
    for (const it of items) {
      if (typeof it.url === "string" && it.url.startsWith("http")) urls.push(it.url);
    }
    if (!urls.length) {
      // أعاد b64_json أو شيئًا غير روابط — لا نستقبل وسائط على السيرفر ⇒ ننتقل للمزود التالي
      throw makeProviderError(200, "cometapi returned inline data without a public URL", "provider");
    }
    return { urls };
  },

  /** فيديو غير متزامن عبر مسار xAI/Grok */
  async createTask(
    key: ProviderKeyRef,
    providerModel: string,
    input: ProviderImageInput | ProviderVideoInput
  ): Promise<{ providerTaskId: string }> {
    const vid = input as ProviderVideoInput;
    const payload: Record<string, unknown> = {
      model: providerModel,
      prompt: vid.prompt,
    };
    if (typeof vid.duration === "number") payload.duration = vid.duration;
    if (vid.aspect_ratio && vid.aspect_ratio !== "auto") payload.aspect_ratio = vid.aspect_ratio;
    if (vid.resolution) payload.resolution = vid.resolution;
    if (vid.image_url) payload.image = { url: vid.image_url };

    const { httpStatus, body } = await fetchJsonWithTimeout(
      `${BASE}/grok/v1/videos/generations`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key.api_key}` },
        body: JSON.stringify(payload),
      }
    );
    assertHttpOk(httpStatus, body, "cometapi video create failed");
    const b = asRecord(body);
    const id =
      (typeof b.request_id === "string" && b.request_id) ||
      (typeof b.task_id === "string" && b.task_id) ||
      (typeof b.id === "string" && b.id) ||
      (typeof asRecord(b.data).request_id === "string" && asRecord(b.data).request_id) ||
      (typeof asRecord(b.data).task_id === "string" && asRecord(b.data).task_id) ||
      null;
    if (!id) {
      throw makeProviderError(0, "cometapi: unexpected video create response", "temporary");
    }
    return { providerTaskId: String(id) };
  },

  async checkTask(key: ProviderKeyRef, providerTaskId: string): Promise<TaskCheckResult> {
    const { httpStatus, body } = await fetchJsonWithTimeout(
      `${BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${key.api_key}` } }
    );
    assertHttpOk(httpStatus, body, "cometapi video poll failed");
    const b = asRecord(body);
    const d = asRecord(b.data);
    const status = String(b.status ?? d.status ?? "").toLowerCase();
    const progressRaw = b.progress ?? d.progress;
    let progress: number | undefined;
    if (typeof progressRaw === "number") {
      progress = progressRaw <= 1 ? Math.round(progressRaw * 100) : Math.round(progressRaw);
    }
    const url =
      (typeof b.video_url === "string" && b.video_url) ||
      (typeof asRecord(b.video).url === "string" && (asRecord(b.video).url as string)) ||
      (typeof d.video_url === "string" && d.video_url) ||
      (typeof asRecord(d.video).url === "string" && (asRecord(d.video).url as string)) ||
      undefined;
    const errMsg =
      (typeof b.error === "string" && b.error) ||
      (typeof d.error === "string" && d.error) ||
      undefined;

    if (status === "done" || status === "completed" || status === "success" || status === "succeeded") {
      if (!url) {
        throw makeProviderError(0, "cometapi: done without a video url", "temporary");
      }
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failed" || status === "expired" || status === "error") {
      // فشل مزود حقيقي — المنسّق يفحص لاحقًا إن كانت الرسالة بنمط مفتاح/رصيد للتبديل
      throw makeProviderError(200, errMsg || "cometapi video failed", "provider");
    }
    return { status: "processing", progress: progress ?? 45 };
  },
};
