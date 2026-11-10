/**
 * مزود kie.ai — Jobs API الموحد (المزود الأساسي)
 * ============================================================
 * الأشكال أدناه مقيسة فعليًا بـ curl على api.kie.ai (وليست مخترعة):
 *   POST /api/v1/jobs/createTask  → {"code":200,"msg":"success","data":{"taskId":"..."}}
 *   GET  /api/v1/jobs/recordInfo?taskId=...
 *        → data.state: waiting|queuing|generating|success|fail
 *        → data.resultJson: **نص JSON داخل JSON** يحتاج JSON.parse ثانيًا:
 *          {"resultUrls":["https://..."]}
 *        → data.failMsg: نص الفشل
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

// تجاوز العنوان للاختبارات فقط (افتراضيًا العنوان الرسمي)
const BASE = process.env.KIE_API_BASE?.trim() || "https://api.kie.ai";

interface KieBody {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

/** يتحقق من صحة الاستجابة ويرمي ProviderError مصنّفًا عند أي خطأ */
function assertKieOk(httpStatus: number, body: KieBody | null, fallbackMsg: string): void {
  // أخطاء HTTP الصريحة
  if (httpStatus >= 400) {
    const msg = extractErrorMessage(body, `HTTP ${httpStatus}: ${fallbackMsg}`);
    throw makeProviderError(httpStatus, msg, classifyProviderError(httpStatus, msg));
  }
  // بعض الأخطاء تصل بحالة 200 لكن code داخل الجسم ≠ 200
  const code = typeof body?.code === "number" ? body.code : 200;
  if (code !== 200) {
    const msg = extractErrorMessage(body, fallbackMsg);
    throw makeProviderError(code, msg, classifyProviderError(code, msg));
  }
}

export const kieAdapter: ProviderAdapter = {
  async createTask(
    key: ProviderKeyRef,
    providerModel: string,
    input: ProviderImageInput | ProviderVideoInput
  ): Promise<{ providerTaskId: string }> {
    // بناء حقول input حسب توثيق docs.kie.ai الرسمي:
    // - الصور: prompt/aspect_ratio/resolution/background/output_format
    // - الفيديو: prompt/image_urls (جمع)/aspect_ratio/resolution/duration/enable_audio
    const payload: Record<string, unknown> = { model: providerModel, input: {} as Record<string, unknown> };
    const inp = payload.input as Record<string, unknown>;

    if ("output_format" in input) {
      // إدخال صورة
      const img = input as ProviderImageInput;
      inp.prompt = img.prompt;
      if (img.aspect_ratio && img.aspect_ratio !== "auto") inp.aspect_ratio = img.aspect_ratio;
      if (img.resolution) inp.resolution = img.resolution;
      if (img.background && img.background !== "auto") inp.background = img.background;
      if (img.output_format) inp.output_format = img.output_format;
    } else {
      // إدخال فيديو
      const vid = input as ProviderVideoInput;
      inp.prompt = vid.prompt;
      if (vid.image_url) inp.image_urls = [vid.image_url];
      if (vid.aspect_ratio && vid.aspect_ratio !== "auto") inp.aspect_ratio = vid.aspect_ratio;
      if (vid.resolution) inp.resolution = vid.resolution;
      if (typeof vid.duration === "number") inp.duration = vid.duration;
      if (typeof vid.enable_audio === "boolean") inp.enable_audio = vid.enable_audio;
    }

    const { httpStatus, body } = await fetchJsonWithTimeout(
      `${BASE}/api/v1/jobs/createTask`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key.api_key}`,
        },
        body: JSON.stringify(payload),
      }
    );
    assertKieOk(httpStatus, body as KieBody, "kie createTask failed");
    const taskId = (body as KieBody)?.data?.taskId;
    if (typeof taskId !== "string" || !taskId) {
      // استجابة غير متوقعة — نعتبرها خطأ مؤقتًا لا علاقة له بالمفتاح
      throw makeProviderError(0, "kie: unexpected createTask response", "temporary");
    }
    return { providerTaskId: taskId };
  },

  async checkTask(key: ProviderKeyRef, providerTaskId: string): Promise<TaskCheckResult> {
    const { httpStatus, body } = await fetchJsonWithTimeout(
      `${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${key.api_key}` } }
    );
    assertKieOk(httpStatus, body as KieBody, "kie recordInfo failed");
    const data = (body as KieBody)?.data ?? {};
    const state = String(data.state ?? "");
    // resultJson نص يحتاج JSON.parse ثانيًا (سلوك حقيقي مقيس)
    let urls: string[] = [];
    const resultJson = data.resultJson;
    if (typeof resultJson === "string" && resultJson.trim()) {
      try {
        const parsed = JSON.parse(resultJson) as { resultUrls?: unknown };
        if (Array.isArray(parsed.resultUrls)) {
          urls = parsed.resultUrls.filter((u): u is string => typeof u === "string" && !!u);
        }
      } catch {
        // إن تغيّر الشكل مستقبلًا نتجاهل بصمت ونبقى في المعالجة
      }
    }

    switch (state) {
      case "success":
        return { status: "completed", urls, progress: 100 };
      case "fail": {
        const failMsg = extractErrorMessage({ failMsg: data.failMsg }, "kie job failed");
        throw makeProviderError(200, failMsg, "provider");
      }
      case "queuing":
        return { status: "processing", progress: 25 };
      case "generating":
        return { status: "processing", progress: 65 };
      case "waiting":
      default:
        return { status: "processing", progress: 12 };
    }
  },
};
