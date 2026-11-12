/**
 * مزود Pollinations — مجاني بلا مفتاح (خطة Free Access)
 * ============================================================
 * سلوك حقيقي مُقاس:
 *   GET https://image.pollinations.ai/prompt/{prompt-encoded}?width=&height=&seed=&model=flux&nologo=true
 *   → HTTP 200 مع بايتات الصورة مباشرة (image/jpeg) — توليد متزامن داخل النداء نفسه.
 *   → 429 عند تجاوز معدل الاستخدام المجاني، 5xx تحت الضغط.
 * لا يُخزَّن أي وسيط على السيرفر: نتحقق من الاستجابة (ok + content-type صورة)
 * ثم نُلغي جسم الرد فورًا ونعيد **رابط التوليد نفسه** كرابط نتيجة —
 * الرابط عام ويُعيد الصورة لأي طالب (نفس prompt+seed ⇒ نتيجة ثابتة مؤقتًا عبر الكاش).
 */
import { makeProviderError, type ProviderError } from "../keys";
import type {
  ProviderAdapter,
  ProviderImageInput,
  ProviderKeyRef,
  ProviderVideoInput,
  TaskCheckResult,
} from "./types";

const BASE = process.env.POLLINATIONS_API_BASE?.trim() || "https://image.pollinations.ai";
const GEN_TIMEOUT_MS = 90_000; // التوليد المجاني قد يستغرق 5–60 ثانية

/** خريطة نسب الأبعاد إلى width×height المدعومة */
const ASPECT_MAP: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1280, 720],
  "9:16": [720, 1280],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
  "3:2": [1216, 832],
  "2:3": [832, 1216],
};

function dimensionsFor(aspect?: string): [number, number] {
  if (aspect) {
    const hit = ASPECT_MAP[aspect.trim()];
    if (hit) return hit;
  }
  return [1024, 1024];
}

function buildImageUrl(providerModel: string, input: ProviderImageInput): string {
  const [width, height] = dimensionsFor(input.aspect_ratio);
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const qs = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model: providerModel || "flux",
    nologo: "true",
  });
  return `${BASE}/prompt/${encodeURIComponent(input.prompt)}?${qs.toString()}`;
}

/**
 * التحقق من أن رابط التوليد يُنتج صورة فعلًا (يُطلق التوليد ويعيد الرد):
 * نقرأ الترويسات فقط ثم نُلغي الجسم — لا يُخزَّن أي بايت من الوسائط.
 */
async function assertImageAvailable(url: string): Promise<void> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), GEN_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (res.status === 429) {
      throw makeProviderError(429, "pollinations rate limited", "temporary");
    }
    if (res.status === 402 || res.status === 403) {
      // قياس حي (2026-11-12): 402 مع {"error":{"code":"FREE_LIMIT","message":"Free limit
      // reached: 1 image every 45 seconds per IP. Retry after 37s..."}} ⇒ حد معدل مجاني
      // مؤقت يُعاد بعده — ليس نفاد رصيد. غير ذلك (403 أو سياسة مرفوضة) ⇒ exhausted.
      const bodyText = await res.text().catch(() => "");
      const m = bodyText.match(/retry after (\d+)\s*s/i) || bodyText.match(/Retry after (\d+)/i);
      if (/free.?limit|rate.?limit|retry after/i.test(bodyText)) {
        const e = makeProviderError(
          res.status,
          `pollinations free limit: retry after ${m ? `${m[1]}s` : "45s"}`,
          "temporary"
        );
        if (m) {
          (e as ProviderError & { retryAfterMs?: number }).retryAfterMs =
            (Number(m[1]) + 2) * 1000;
        }
        throw e;
      }
      const msg = `pollinations free access rejected: HTTP ${res.status}`;
      throw makeProviderError(res.status, msg, "exhausted");
    }
    if (!res.ok) {
      const msg = `pollinations generation failed: HTTP ${res.status}`;
      const cls = res.status >= 500 ? "temporary" : "provider";
      throw makeProviderError(res.status, msg, cls);
    }
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.startsWith("image/")) {
      throw makeProviderError(0, `pollinations: unexpected content-type ${ct || "empty"}`, "temporary");
    }
    // إلغاء الجسم فورًا — لا تنزيل للوسائط على السيرفر (روابط فقط)
    try {
      await res.body?.cancel();
    } catch {
      // لا شيء — الإلغاء تحسين لا شرط
    }
  } catch (e: unknown) {
    if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) {
      throw makeProviderError(0, "pollinations generation timeout", "temporary");
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const pollinationsAdapter: ProviderAdapter = {
  // لا مهام غير متزامنة هنا — الصور متزامنة عبر createImageSync
  async createTask(
    _key: ProviderKeyRef,
    _providerModel: string,
    _input: ProviderImageInput | ProviderVideoInput
  ): Promise<{ providerTaskId: string }> {
    throw makeProviderError(0, "pollinations: synchronous images only", "temporary");
  },

  async createImageSync(
    _key: ProviderKeyRef,
    providerModel: string,
    input: ProviderImageInput
  ): Promise<{ urls: string[] }> {
    const url = buildImageUrl(providerModel, input);
    // النداء نفسه يُطلق التوليد ويتحقق من نجاحه قبل إعلان الاكتمال
    await assertImageAvailable(url);
    return { urls: [url] };
  },

  // لا يُستدعى فعليًا (المهام المتزامنة تكتمل فورًا) — دفاعية فقط
  async checkTask(): Promise<TaskCheckResult> {
    return { status: "processing", progress: 50 };
  },
};
