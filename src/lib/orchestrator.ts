/**
 * منسّق التوليد — runGeneration / refreshTask / runMerge / refreshMergeTask
 * ============================================================
 * سياسة التبديل «لا توقف أبدًا» (بند 4.3):
 * 1) المرشحون يُجرَّبون بالترتيب التسلسلي الصارم؛ أول نجاح يربط المهمة بالمزود والمفتاح.
 * 2) كل محاولة (نجاح/فشل + فئتها) تُسجَّل في attempts_json وعدّادات المفتاح تُحدَّث دائمًا.
 * 3) فشل منتصف المهمة برسالة بنمط مفتاح/رصيد ⇒ إعادة إنشاء نفس المهمة بنفس task_id
 *    على المفتاح التالي — العميل يرى «قيد المعالجة» فقط ولا يعلم بأي تبديل.
 * 4) فشل الإنشاء على كل المفاتيح ⇒ المهمة تبقى processing (وليست failed) برسالة داخلية،
 *    وتُعاد المحاولة تلقائيًا مع كل get_task بعد تهدئة ~45 ثانية.
 * 5) نموذج الذكاء الاصطناعي لا يرى أبدًا أخطاء مفاتيح/رصيد — التعقيم في clientSafeError.
 */
import { randomUUID } from "node:crypto";
import {
  classifyProviderError,
  getKeyPool,
  makeProviderError,
  recordKeyFailure,
  recordKeySuccess,
  type ErrorClass,
  type ProviderError,
} from "./keys";
import { mergerBase, createMergerJob, getMergerJob, processMergerJob, createMergerSlideshow, getMergerSlideshow, processMergerSlideshow, type MergerJobState } from "./merger";
import { modelByCanonical, type ModelDef, type MediaType, type ProviderId, type TaskProvider } from "./models";
import { cometapiAdapter } from "./providers/cometapi";
import { kieAdapter } from "./providers/kie";
import { pollinationsAdapter } from "./providers/pollinations";
import type { ProviderAdapter, ProviderKeyRef } from "./providers/types";
import {
  getApiKey,
  getTask,
  insertTask,
  updateTask,
  type TaskAttempt,
  type TaskRow,
} from "./turso";

const ADAPTERS: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
  pollinations: pollinationsAdapter,
};

/** موديل التعليق المصوّر في جدول المهام — يميّز مسار slideshow عن merge عند provider=merger */
const SLIDESHOW_MODEL = "narrated-slideshow";

/** مزود بلا مفتاح — يُحقن كمرشّح مصطنع في آخر الترتيب التسلسلي إن لم يوجد مفتاح حقيقي له */
const KEYLESS_PROVIDERS = new Set<string>(["pollinations"]);

function syntheticKeyCandidate(provider: string, position: number) {
  return {
    provider,
    key: {
      id: `synthetic:${provider}`,
      provider,
      label: `${provider} مجاني`,
      api_key: "",
      status: "active",
      usage_count: 0,
      success_count: 0,
      fail_count: 0,
      last_used_at: null,
      last_checked_at: null,
      last_error: null,
      created_at: "",
    },
    position,
    synthetic: true,
  };
}

/** نمط رسائل مشكلات المفتاح/الرصيد — يُستخدم لقرار التبديل في منتصف المهمة (4.3.2) */
const KEY_FAIL_PATTERN =
  /insufficient|balance|credit|quota|exhausted|充值|402|401|unauthorized|invalid api key|forbidden|api key/i;

/** نمط تعقيم ما يخرج للعميل — لا تُذكر مفاتيح أو أرصدة إطلاقًا */
const SECRET_PATTERN = /insufficient|balance|credit|quota|exhausted|充值|unauthorized|invalid api key|forbidden|402|401|api key|مفتاح|رصيد|key/i;

const COOLDOWN_MS = 45_000; // تهدئة إعادة المحاولة على كل get_task
const POLL_INTERVAL_MS = 3_000; // الاستعلام كل 3 ثوانٍ أثناء نافذة الانتظار

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clampWait(v: number | undefined, def: number): number {
  if (typeof v !== "number" || Number.isNaN(v)) return def;
  return Math.max(0, Math.min(240, Math.round(v)));
}

/** تعقيم رسالة الخطأ قبل خروجها للعميل — أي ذِكر لمفاتيح/رصيد يُستبدل برسالة عامة */
export function clientSafeError(msg?: string | null): string {
  if (!msg || !msg.trim()) return "تعذر إكمال المهمة — ستتم إعادة المحاولة تلقائيًا.";
  if (SECRET_PATTERN.test(msg)) {
    return "تعذر إكمال المهمة حاليًا — ستُعاد المحاولة تلقائيًا عند توفر مورد صالح.";
  }
  return msg;
}

export interface ProgressCb {
  (progress: number, message: string): Promise<void> | void;
}

/* ============================================================
 *                منطق إنشاء المهمة على المزود
 * ============================================================ */

interface CreateOutcome {
  ok: boolean;
  provider?: TaskProvider;
  keyId?: string;
  syncUrls?: string[];
}

/**
 * تجربة المرشحين بالترتيب حتى أول نجاح.
 * triedKeyIds: مفاتيح جُرِّبت داخل نفس سلسلة التنفيذ فتُتخطى (التبديل للأمام فقط).
 * كل محاولة تُسجَّل في attempts_json + عدّادات المفتاح.
 */
async function attemptCreation(
  taskId: string,
  model: ModelDef,
  input: Record<string, unknown>,
  triedKeyIds: Set<string>
): Promise<CreateOutcome> {
  const pool = await getKeyPool(model.providers);
  // مزود بلا مفتاح (pollinations): يُضاف مصطنعًا في **آخر** الترتيب التسلسلي
  // ما لم يوجد مفتاح حقيقي له في القاعدة (لو تغيّرت سياستهم مستقبلًا وتطلب توكن)
  for (const p of model.providers) {
    if (!KEYLESS_PROVIDERS.has(p)) continue;
    if (pool.some((c) => c.provider === p)) continue;
    pool.push(syntheticKeyCandidate(p, pool.length));
  }
  for (const cand of pool) {
    if (triedKeyIds.has(cand.key.id)) continue;
    const adapter = ADAPTERS[cand.provider];
    if (!adapter) continue;
    const providerModel = model.providerModel[cand.provider as ProviderId] ?? "";
    const keyRef: ProviderKeyRef = {
      id: cand.key.id,
      api_key: cand.key.api_key,
      label: cand.key.label || "",
    };

    // تسجيل المحاولة دائمًا — نجاحًا أو فشلًا
    const attempt: TaskAttempt = {
      provider: cand.provider,
      keyId: cand.key.id,
      keyLabel: cand.key.label || "",
      ok: false,
      at: new Date().toISOString(),
    };

    try {
      if (model.type === "image" && adapter.createImageSync) {
        // صور متزامنة (CometAPI / Pollinations): النتيجة فورية
        const { urls } = await adapter.createImageSync(keyRef, providerModel, input as never);
        attempt.ok = true;
        await updateTask(taskId, { attempts: [attempt] });
        if (!cand.synthetic) await recordKeySuccess(cand.key);
        return { ok: true, provider: cand.provider as TaskProvider, keyId: cand.key.id, syncUrls: urls };
      }
      const { providerTaskId } = await adapter.createTask(keyRef, providerModel, input as never);
      attempt.ok = true;
      await updateTask(taskId, {
        attempts: [attempt],
        provider: cand.provider,
        provider_task_id: providerTaskId,
        key_id: cand.key.id,
        status: "processing",
        progress: 5,
      });
      if (!cand.synthetic) await recordKeySuccess(cand.key);
      return { ok: true, provider: cand.provider as TaskProvider, keyId: cand.key.id };
    } catch (e) {
      const pe = e as ProviderError;
      const errClass: ErrorClass =
        pe && typeof pe === "object" && "class" in pe ? (pe.class as ErrorClass) : classifyProviderError(0, String(pe));
      const msg = pe instanceof Error ? pe.message : String(pe);
      attempt.ok = false;
      attempt.errorClass = errClass;
      attempt.error = msg.slice(0, 300);
      await updateTask(taskId, { attempts: [attempt] });
      if (!cand.synthetic) await recordKeyFailure(cand.key, errClass, msg);

      if (errClass === "params") {
        // خطأ معطيات — تبديل المفاتيح لن يحلّه: توقف فورًا بفشل حقيقي
        await updateTask(taskId, {
          status: "failed",
          error_message: clientSafeError(msg),
        });
        return { ok: false };
      }
      // disabled / exhausted / provider / temporary ⇒ الانتقال للمفتاح التالي بصمت
      triedKeyIds.add(cand.key.id);
      continue;
    }
  }
  return { ok: false };
}

/* ============================================================
 *                 نافذة انتظار التوليد
 * ============================================================ */

async function pollOnce(
  task: TaskRow,
  model: ModelDef
): Promise<{ done: boolean; failed: boolean; urls?: string[] }> {
  if (!task.provider_task_id || !task.key_id) return { done: false, failed: false };
  const keyRow = await getApiKey(task.key_id);
  if (!keyRow) return { done: false, failed: false };
  const adapter = ADAPTERS[task.provider ?? ""];
  if (!adapter) return { done: false, failed: false };
  const providerModel = model.providerModel[task.provider as ProviderId] ?? "";

  try {
    const r = await adapter.checkTask(
      { id: keyRow.id, api_key: keyRow.api_key, label: keyRow.label || "" },
      task.provider_task_id,
      providerModel
    );
    if (r.status === "completed" && r.urls?.length) {
      await recordKeySuccess(keyRow);
      await updateTask(task.id, {
        status: "completed",
        progress: 100,
        result_urls: r.urls,
      });
      return { done: true, failed: false, urls: r.urls };
    }
    await updateTask(task.id, { progress: r.progress ?? task.progress });
    return { done: false, failed: false };
  } catch (e) {
    const pe = e as ProviderError;
    const msg = pe instanceof Error ? pe.message : String(pe);
    const errClass: ErrorClass =
      pe && typeof pe === "object" && "class" in pe ? (pe.class as ErrorClass) : classifyProviderError(0, msg);

    // فشل منتصف المهمة برسالة بنمط مفتاح/رصيد ⇒ تبديل صامت (4.3.2)
    const isKeyLike = KEY_FAIL_PATTERN.test(msg) || errClass === "disabled" || errClass === "exhausted";
    if (isKeyLike) {
      await recordKeyFailure(keyRow, errClass === "provider" ? "temporary" : errClass, msg);
      // إزالة الربط الحالي لإعادة الإنشاء على مفتاح آخر بنفس task_id
      await updateTask(task.id, {
        provider: null,
        provider_task_id: null,
        key_id: null,
        status: "processing",
        error_message: "بانتظار توفر مفتاح صالح…",
      });
      return { done: false, failed: false, urls: undefined };
    }
    if (errClass === "params") {
      await updateTask(task.id, { status: "failed", error_message: clientSafeError(msg) });
      return { done: false, failed: true };
    }
    if (errClass === "provider") {
      // فشل حقيقي من المزود (سياسة/محتوى/موديل) وليس مشكلة مفتاح
      await updateTask(task.id, { status: "failed", error_message: clientSafeError(msg) });
      return { done: false, failed: true };
    }
    // temporary — نستمر بالاستعلام
    return { done: false, failed: false };
  }
}

/**
 * التوليد: تسجيل المهمة ثم تجربة المفاتيح بالترتيب ثم نافذة انتظار ببث تقدم.
 * يعيد المهمة النهائية (مكتملة) أو مهمة processing يتابعها العميل بـ get_task.
 */
export async function runGeneration(opts: {
  model: ModelDef;
  params: {
    prompt: string;
    aspect_ratio?: string;
    resolution?: string;
    background?: string;
    output_format?: string;
    image_url?: string;
    enable_audio?: boolean;
    duration?: number;
  };
  wait_seconds?: number;
  onProgress?: ProgressCb;
}): Promise<TaskRow> {
  const { model, params } = opts;
  const defaultWait = model.type === "image" ? 90 : 25;
  const waitSeconds = clampWait(opts.wait_seconds, defaultWait);

  // بناء input المعطيات الأصلية (تُخزَّن لإعادة الإنشاء عند التبديل)
  const input: Record<string, unknown> = { prompt: params.prompt };
  if (params.aspect_ratio) input.aspect_ratio = params.aspect_ratio;
  if (params.resolution) input.resolution = params.resolution;
  if (params.background) input.background = params.background;
  if (params.output_format) input.output_format = params.output_format;
  if (params.image_url) input.image_url = params.image_url;
  if (typeof params.enable_audio === "boolean") input.enable_audio = params.enable_audio;
  if (typeof params.duration === "number") input.duration = params.duration;

  // تسجيل المهمة قبل أي نداء خارجي (حتى لو انقطع الاتصال تبقى قابلة للتتبع)
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: model.canonical,
    type: model.type,
    prompt: params.prompt,
    params: input,
    status: "pending",
  });

  // تجربة المفاتيح بالترتيب التسلسلي الصارم
  const tried = new Set<string>();
  const outcome = await attemptCreation(taskId, model, input, tried);

  if (!outcome.ok) {
    const still = await getTask(taskId);
    if (still && still.status !== "failed") {
      // بقيت processing برسالة داخلية — تُعاد محاولتها مع كل get_task
      await updateTask(taskId, {
        status: "processing",
        error_message: "بانتظار توفر مفتاح صالح…",
        params_merge: { _lastCreateAttempt: new Date().toISOString() },
      });
    }
    return (await getTask(taskId))!;
  }

  // صور متزامنة اكتملت فورًا
  if (outcome.syncUrls?.length) {
    await updateTask(taskId, {
      provider: outcome.provider,
      key_id: outcome.keyId,
      status: "completed",
      progress: 100,
      result_urls: outcome.syncUrls,
    });
    return (await getTask(taskId))!;
  }

  // نافذة الانتظار: استعلام كل 3 ثوانٍ + بث تقدم
  let task = await getTask(taskId)!;
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    task = (await getTask(taskId))!;
    if (task.status === "completed" || task.status === "failed") return task;

    // لم تُنشأ لدى المزود بعد (فشل كل المفاتيح سابقًا) — نعيد المحاولة داخل النافذة
    if (!task.provider_task_id) {
      const again = await attemptCreation(taskId, model, input, new Set());
      if (again.syncUrls?.length) {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: again.syncUrls });
        return (await getTask(taskId))!;
      }
      continue;
    }

    const r = await pollOnce(task, model);
    if (r.done) return (await getTask(taskId))!;
    if (r.failed) return (await getTask(taskId))!;

    const fresh = await getTask(taskId)!;
    const pct = fresh?.progress ?? 0;
    await opts.onProgress?.(
      pct,
      fresh && !fresh.provider_task_id
        ? "بانتظار توفر مفتاح صالح… جارٍ إعادة المحاولة تلقائيًا"
        : `قيد التوليد… ${pct}%`
    );
  }
  // انتهت النافذة دون نتيجة ⇒ processing ويكملها العميل بـ get_task
  return (await getTask(taskId))!;
}

/* ============================================================
 *         refreshTask — تتبع حي عبر get_task
 * ============================================================ */

/** إعادة إنشاء مهمة بلا ربط حالي (فشلت كل المفاتيح سابقًا) بعد تهدئة 45 ثانية */
async function retryPendingCreation(task: TaskRow): Promise<TaskRow> {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(task.params_json || "{}");
  } catch {
    meta = {};
  }
  const last = typeof meta._lastCreateAttempt === "string" ? Date.parse(meta._lastCreateAttempt) : 0;
  if (Date.now() - last < COOLDOWN_MS) return task; // داخل فترة التهدئة — ننتظر

  const input = meta as Record<string, unknown>;
  const model = modelByCanonical(task.model);
  if (!model) return task;

  await updateTask(task.id, { params_merge: { _lastCreateAttempt: new Date().toISOString() } });
  const outcome = await attemptCreation(task.id, model, input, new Set());
  if (outcome.syncUrls?.length) {
    await updateTask(task.id, { status: "completed", progress: 100, result_urls: outcome.syncUrls });
  }
  return (await getTask(task.id))!;
}

export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  const task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  // دمج / تعليق مصوّر: منطق merger مستقل — نفرّق بالموديل
  if (task.provider === "merger") {
    return task.model === SLIDESHOW_MODEL ? refreshSlideshowTask(task) : refreshMergeTask(task);
  }

  // لم تُنشأ بعد لدى المزود ⇒ إعادة محاولة الإنشاء (بتهدئة)
  if (!task.provider_task_id || !task.key_id) {
    return retryPendingCreation(task);
  }

  const model = modelByCanonical(task.model);
  if (!model) return task;

  const r = await pollOnce(task, model);
  if (r.done || r.failed) return (await getTask(taskId))!;

  // فشل منتصف المهمة بنمط مفتاح/رصيد ⇒ أعاد pollOnce الربط إلى null —
  // نعيد الإنشاء فورًا على المفتاح التالي بنفس task_id (نتجاوز التهدئة هذه المرة
  // لأن التهدئة تخص فقط إعادة المحاولة عند «عدم توفر أي مفتاح»، لا التبديل الحي)
  const fresh = await getTask(taskId)!;
  if (fresh && !fresh.provider_task_id) {
    await updateTask(fresh.id, {
      params_merge: { _lastCreateAttempt: new Date(0).toISOString() },
    });
    return retryPendingCreation(fresh);
  }
  return fresh;
}

/* ============================================================
 *                دمج الفيديوهات — runMerge
 * ============================================================ */

// قفل بالذاكرة حتى لا يتزامن نداء process مع get_task (بند 7.3.3)
const processInFlight = new Set<string>();

async function fireProcessOnce(taskId: string, jobId: string, kind: "merge" | "slideshow"): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  // إطلاق خلفي بمرة واحدة فقط — النتيجة تُقرأ لاحقًا من GET الحالة
  void (async () => {
    try {
      if (kind === "slideshow") await processMergerSlideshow(jobId);
      else await processMergerJob(jobId);
    } catch {
      // فشل process المعلن يظهر في GET status كذلك — لا نتعامل هنا
    } finally {
      processInFlight.delete(jobId);
    }
  })();
  await updateTask(taskId, { params_merge: { processStarted: true } });
}

async function applyMergerState(taskId: string, st: MergerJobState): Promise<"done" | "failed" | "continue"> {
  if (st.status === "done") {
    // رابط النتيجة: videoUrl ثم downloadUrl ثم البناء من jobId (تم في merger.ts)
    const url = st.videoUrl ?? st.downloadUrl;
    if (!url) {
      await updateTask(taskId, { status: "failed", error_message: "اكتمل الدمج دون رابط نتيجة" });
      return "failed";
    }
    await updateTask(taskId, {
      status: "completed",
      progress: 100,
      result_urls: [url],
    });
    return "done";
  }
  if (st.status === "failed") {
    await updateTask(taskId, { status: "failed", error_message: st.error ?? "فشل الدمج" });
    return "failed";
  }
  await updateTask(taskId, { status: "processing", progress: st.progress });
  return "continue";
}

export interface MergeOutcome {
  task?: TaskRow | null; // getTask قد تعيد null عند فقدان الصف
  error?: string; // رسالة عربية جاهزة
}

/**
 * دمج عدة مقاطع في فيديو واحد بالترتيب المعطى.
 * التحقق الصارم: ≥2 و ≤10 وروابط http/https مباشرة عامة.
 * روابط task_ids تُحل أُولًا ثم urls المباشرة بنفس ترتيبها.
 */
export async function runMerge(opts: {
  urls?: string[];
  task_ids?: string[];
  wait_seconds?: number;
  onProgress?: ProgressCb;
}): Promise<MergeOutcome> {
  const urls: string[] = [];
  const failedRefs: string[] = [];

  // 1) حل روابط task_ids من قاعدة البيانات بالترتيب
  for (const tid of opts.task_ids ?? []) {
    const t = await getTask(tid.trim());
    if (!t || t.status !== "completed" || !t.result_urls_json) {
      failedRefs.push(`${tid}: ${!t ? "غير موجودة" : t.status === "failed" ? "فاشلة" : "غير مكتملة بعد"}`);
      continue;
    }
    try {
      const arr = JSON.parse(t.result_urls_json) as string[];
      if (arr.length) urls.push(arr[0]);
    } catch {
      failedRefs.push(`${tid}: روابط نتيجتها تالفة`);
    }
  }
  // 2) ثم الروابط المباشرة بنفس ترتيبها
  for (const u of opts.urls ?? []) urls.push(u.trim());

  if (urls.length + failedRefs.length < 2) {
    return {
      error:
        "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة." +
        (failedRefs.length ? `\nتفاصيل: ${failedRefs.join(" | ")}` : ""),
    };
  }
  if (failedRefs.length) {
    return { error: `❌ تعذّر حل بعض المعرفات للدمج: ${failedRefs.join(" | ")}` };
  }
  if (urls.length > 10) {
    return { error: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  // روابط مباشرة عامة فقط
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) {
      return { error: `❌ كل المقاطع يجب أن تكون روابط http/https مباشرة وعامة — رفض: ${u.slice(0, 120)}` };
    }
  }

  // تسجيل المهمة أولًا ثم النداء على الخدمة
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع`,
    params: { videos: urls },
    status: "processing",
  });

  let jobId: string;
  try {
    const created = await createMergerJob(urls);
    jobId = created.jobId;
  } catch (e) {
    const pe = e as ProviderError;
    const terminal = (pe as ProviderError & { mergerTerminal?: boolean }).mergerTerminal === true;
    if (terminal) {
      await updateTask(taskId, { status: "failed", error_message: clientSafeError(pe.message) });
      return { task: await getTask(taskId) };
    }
    // شبكتنا نحن — تبقى processing وتُعاد المحاولة مع get_task
    await updateTask(taskId, {
      status: "processing",
      error_message: "تعذر إنشاء مهمة الدمج الآن — ستُعاد المحاولة تلقائيًا مع get_task",
      params_merge: { _lastCreateAttempt: new Date().toISOString(), _videos: urls },
    });
    return { task: await getTask(taskId) };
  }

  await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 5 });
  await fireProcessOnce(taskId, jobId, "merge");

  // نافذة الانتظار الافتراضية 60 ثانية — استعلام كل 3 ثوانٍ وكتابة الحالة فورًا
  const waitSeconds = clampWait(opts.wait_seconds, 60);
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let st: MergerJobState;
    try {
      st = await getMergerJob(jobId);
    } catch (e) {
      const pe = e as ProviderError;
      if ((pe as ProviderError & { mergerTerminal?: boolean }).mergerTerminal) {
        // 404/فشل معلن من الخدمة = نهائي (لكن إن لم يبدأ process بعد فقد استُدعي الآن فورًا)
        await updateTask(taskId, { status: "failed", error_message: clientSafeError(pe.message) });
        return { task: await getTask(taskId) };
      }
      continue; // شبكتنا نحن — نستمر حتى نهاية النافذة
    }
    const r = await applyMergerState(taskId, st);
    if (r === "done" || r === "failed") return { task: await getTask(taskId) };
    await opts.onProgress?.(st.progress, `جارٍ الدمج… ${st.progress}%`);
  }
  return { task: await getTask(taskId) };
}

/** تتبع مهمة دمج جارية عبر get_task (بند 7.3.6) */
export async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  // لم يُنشأ jobId بعد ⇒ إعادة محاولة الإنشاء بعد تهدئة
  if (!task.provider_task_id) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(task.params_json || "{}");
    } catch {
      meta = {};
    }
    const videos = (meta._videos as string[] | undefined) ?? (meta.videos as string[] | undefined) ?? [];
    const last = typeof meta._lastCreateAttempt === "string" ? Date.parse(meta._lastCreateAttempt) : 0;
    if (!videos.length || Date.now() - last < COOLDOWN_MS) return task;
    try {
      const created = await createMergerJob(videos);
      await updateTask(task.id, {
        provider_task_id: created.jobId,
        status: "processing",
        error_message: null,
      });
      await fireProcessOnce(task.id, created.jobId, "merge");
    } catch {
      await updateTask(task.id, { params_merge: { _lastCreateAttempt: new Date().toISOString() } });
    }
    return (await getTask(task.id))!;
  }

  const jobId = task.provider_task_id;

  // إن لم يُنفَّذ process بعد فنفّذه الآن (مثلًا: انتهت النافذة الأولى قبل إطلاقه)
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(task.params_json || "{}");
  } catch {
    meta = {};
  }
  if (!meta.processStarted) await fireProcessOnce(task.id, jobId, "merge");

  try {
    const st = await getMergerJob(jobId);
    await applyMergerState(task.id, st);
  } catch (e) {
    const pe = e as ProviderError;
    if ((pe as ProviderError & { mergerTerminal?: boolean }).mergerTerminal) {
      await updateTask(task.id, { status: "failed", error_message: clientSafeError(pe.message) });
    }
    // شبكتنا نحن ⇒ تبقى processing حتى الاستعلام التالي
  }
  return (await getTask(task.id))!;
}

/* ============================================================
 *           صياغة الردود العربية الجاهزة للعميل
 * ============================================================ */

export function formatTaskForClient(task: TaskRow): string {
  if (task.status === "completed") {
    let urls: string[] = [];
    try {
      urls = JSON.parse(task.result_urls_json || "[]");
    } catch {
      urls = [];
    }
    if (task.type === "image") {
      const lines = ["✅ تم توليد الصورة بنجاح", ""];
      for (const u of urls) lines.push(`![image](${u})`, "", `الرابط المباشر: ${u}`);
      return lines.join("\n");
    }
    if (task.type === "merge") {
      const lines = ["✅ تم دمج المقاطع بنجاح", ""];
      for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
      lines.push("", "⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.");
      return lines.join("\n");
    }
    const lines = ["✅ تم توليد الفيديو بنجاح", ""];
    for (const u of urls) lines.push(`الرابط المباشر: ${u}`);
    return lines.join("\n");
  }
  if (task.status === "failed") {
    return `❌ فشلت المهمة: ${clientSafeError(task.error_message)}`;
  }
  const pct = task.progress ?? 0;
  return (
    `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\n` +
    `التقدم الحالي: ${pct}%\n` +
    `تابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`
  );
}

/* ============================================================
 *      التعليق المصوّر — runSlideshow (صور + صوت راوي)
 * ============================================================ */

/**
 * حل عناصر الصور: الروابط المباشرة تُمرَّر كما هي، والنصوص تُولَّد كصور
 * بالترتيب التسلسلي (المفاتيح أولًا ثم Pollinations المجاني أخيرًا).
 * حد المعدل المجاني (صورة كل ~45 ث/‏IP) يُعالج بانتظار retryAfterMs حتى سقف waitSeconds.
 */
async function resolveImageUrls(
  items: string[],
  aspect: string,
  waitSeconds: number,
  onProgress?: ProgressCb
): Promise<string[]> {
  const imageModel = modelByCanonical("gpt-image-2-6/flare-text-to-image");
  if (!imageModel) throw new Error("موديل الصور غير معرّف");
  const deadline = Date.now() + waitSeconds * 1000;
  const prompts = items.filter((i) => !/^https?:\/\//i.test(i)).length;
  const urls: string[] = [];
  let generated = 0;

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx].trim();
    if (/^https?:\/\//i.test(item)) {
      urls.push(item);
      continue;
    }
    let done = false;
    let lastErr = "";
    while (!done && Date.now() < deadline) {
      const pool = await getKeyPool(imageModel.providers);
      for (const p of imageModel.providers) {
        if (!KEYLESS_PROVIDERS.has(p)) continue;
        if (pool.some((c) => c.provider === p)) continue;
        pool.push(syntheticKeyCandidate(p, pool.length));
      }
      let retriable = false;
      for (const cand of pool) {
        const adapter = ADAPTERS[cand.provider];
        if (!adapter?.createImageSync) continue;
        const providerModel = imageModel.providerModel[cand.provider as ProviderId] ?? "";
        try {
          const { urls: u } = await adapter.createImageSync(
            { id: cand.key.id, api_key: cand.key.api_key, label: cand.key.label || "" },
            providerModel,
            { prompt: item, aspect_ratio: aspect }
          );
          if (u.length) {
            urls.push(u[0]);
            done = true;
          }
          break;
        } catch (e) {
          const pe = e as ProviderError;
          const cls: ErrorClass =
            pe && typeof pe === "object" && "class" in pe
              ? (pe.class as ErrorClass)
              : classifyProviderError(0, String(pe));
          lastErr = pe instanceof Error ? pe.message : String(pe);
          if (cls === "temporary") {
            const wait = Math.min(
              (pe as ProviderError & { retryAfterMs?: number }).retryAfterMs ?? 8_000,
              Math.max(1_000, deadline - Date.now())
            );
            await sleep(wait);
            retriable = true;
            break; // أعد المحاولة من أول الترتيب بعد الانتظار
          }
          // disabled/exhausted/provider ⇒ المزود التالي فورًا
          continue;
        }
      }
      if (!done && !retriable && Date.now() < deadline) {
        // كل المزودين فشلوا بأخطاء غير مؤقتة — لا فائدة من مواصلة الانتظار
        throw new Error(`تعذر توليد الصورة ${generated + 1}: ${clientSafeError(lastErr)}`);
      }
    }
    if (!done) {
      throw new Error(
        `انتهى وقت تجهيز الصور قبل الاكتمال — الوصول المجاني يسمح بصورة كل ~45 ثانية (${prompts} صور نصية ≈ ${prompts * 45} ث). ` +
          `الحلول: مرّر روابط صور جاهزة بدل الأوصاف، أو قلّل عدد الصور، أو زد wait_seconds حتى 240.`
      );
    }
    generated++;
    await onProgress?.(
      Math.round((generated / prompts) * 100),
      `تجهيز الصور ${generated}/${prompts}…`
    );
  }
  return urls;
}

export interface SlideshowOutcome {
  task?: TaskRow | null;
  error?: string;
}

/** فيديو تعليق مصوّر: صور (روابط أو أوصاف) + نص راوي أو صوت جاهز */
export async function runSlideshow(opts: {
  images: string[];
  narration_text?: string;
  audio_url?: string;
  voice_lang?: string;
  per_image_seconds?: number;
  resolution?: string;
  aspect_ratio?: string;
  wait_seconds?: number;
  onProgress?: ProgressCb;
}): Promise<SlideshowOutcome> {
  const images = (opts.images ?? []).map((s) => String(s || "").trim()).filter(Boolean);
  if (images.length < 1) return { error: "❌ مرّر صورة واحدة على الأقل — رابط مباشر أو وصف نصي لتوليدها." };
  if (images.length > 20) return { error: "❌ أقصى عدد صور هو 20." };
  const narration = (opts.narration_text || "").trim();
  const audioUrl = (opts.audio_url || "").trim();
  if (!narration && !audioUrl) {
    return { error: "❌ مرّر نص التعليق الصوتي narration_text أو رابط صوت جاهز audio_url." };
  }
  if (narration && audioUrl) {
    return { error: "❌ مرّر narration_text أو audio_url — ليس الاثنين معًا." };
  }
  if (narration.length > 8000) return { error: "❌ نص التعليق طويل جدًا (الحد 8000 حرف)." };
  const aspect = ["16:9", "9:16", "1:1"].includes(opts.aspect_ratio || "") ? opts.aspect_ratio! : "16:9";
  const resolution = ["480p", "720p", "1080p"].includes(opts.resolution || "") ? opts.resolution! : "720p";

  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: SLIDESHOW_MODEL,
    type: "video",
    prompt: narration ? `تعليق مصوّر: ${narration.slice(0, 80)}` : `تعليق مصوّر (${images.length} صور بصوت جاهز)`,
    params: { images, narration_text: narration, audio_url: audioUrl, aspect_ratio: aspect, resolution },
    status: "processing",
  });

  // 1) تجهيز روابط الصور (توليد للنصوص)
  let urls: string[];
  try {
    const waitSeconds = clampWait(opts.wait_seconds, 120);
    urls = await resolveImageUrls(images, aspect, waitSeconds, opts.onProgress);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await updateTask(taskId, { status: "failed", error_message: clientSafeError(msg) });
    return { task: await getTask(taskId) };
  }

  // 2) إنشاء المهمة في خدمة الدمج
  let jobId: string;
  try {
    const created = await createMergerSlideshow({
      images: urls,
      narration_text: narration || undefined,
      audio_url: audioUrl || undefined,
      voice_lang: opts.voice_lang || "ar",
      per_image_seconds: opts.per_image_seconds,
      resolution,
      aspect_ratio: aspect,
    });
    jobId = created.jobId;
  } catch (e) {
    const pe = e as ProviderError;
    const terminal = (pe as ProviderError & { mergerTerminal?: boolean }).mergerTerminal === true;
    if (terminal) {
      await updateTask(taskId, { status: "failed", error_message: clientSafeError(pe.message) });
      return { task: await getTask(taskId) };
    }
    await updateTask(taskId, {
      status: "processing",
      error_message: "تعذر إنشاء مهمة التعليق الآن — ستُعاد المحاولة تلقائيًا مع get_task",
      params_merge: { _lastCreateAttempt: new Date().toISOString(), _slideshow: { images: urls, narration_text: narration, audio_url: audioUrl, voice_lang: opts.voice_lang || "ar", per_image_seconds: opts.per_image_seconds, resolution, aspect_ratio: aspect } },
    });
    return { task: await getTask(taskId) };
  }

  await updateTask(taskId, { provider_task_id: jobId, status: "processing", progress: 5 });
  await fireProcessOnce(taskId, jobId, "slideshow");

  // 3) نافذة انتظار مع بث التقدم
  const waitSeconds = clampWait(opts.wait_seconds, 120);
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let st: MergerJobState;
    try {
      st = await getMergerSlideshow(jobId);
    } catch (e) {
      const pe = e as ProviderError;
      if ((pe as ProviderError & { mergerTerminal?: boolean }).mergerTerminal) {
        await updateTask(taskId, { status: "failed", error_message: clientSafeError(pe.message) });
        return { task: await getTask(taskId) };
      }
      continue;
    }
    const r = await applyMergerState(taskId, st);
    if (r === "done" || r === "failed") return { task: await getTask(taskId) };
    await opts.onProgress?.(st.progress, `بناء الفيديو… ${st.progress}%`);
  }
  return { task: await getTask(taskId) };
}

/** تتبع مهمة تعليق مصوّر جارية عبر get_task — نفس منطق الدمج مع إنشاء/معالجة slideshow */
export async function refreshSlideshowTask(task: TaskRow): Promise<TaskRow> {
  if (!task.provider_task_id) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(task.params_json || "{}");
    } catch {
      meta = {};
    }
    const ss = (meta._slideshow ?? null) as
      | { images: string[]; narration_text?: string; audio_url?: string; voice_lang?: string; per_image_seconds?: number; resolution?: string; aspect_ratio?: string }
      | null;
    const last = typeof meta._lastCreateAttempt === "string" ? Date.parse(meta._lastCreateAttempt) : 0;
    if (!ss || Date.now() - last < COOLDOWN_MS) return task;
    try {
      const created = await createMergerSlideshow({
        images: ss.images,
        narration_text: ss.narration_text || undefined,
        audio_url: ss.audio_url || undefined,
        voice_lang: ss.voice_lang || "ar",
        per_image_seconds: ss.per_image_seconds,
        resolution: ss.resolution || "720p",
        aspect_ratio: ss.aspect_ratio || "16:9",
      });
      await updateTask(task.id, {
        provider_task_id: created.jobId,
        status: "processing",
        error_message: null,
      });
      await fireProcessOnce(task.id, created.jobId, "slideshow");
    } catch {
      await updateTask(task.id, { params_merge: { _lastCreateAttempt: new Date().toISOString() } });
    }
    return (await getTask(task.id))!;
  }

  const jobId = task.provider_task_id;
  let meta2: Record<string, unknown> = {};
  try {
    meta2 = JSON.parse(task.params_json || "{}");
  } catch {
    meta2 = {};
  }
  if (!meta2.processStarted) await fireProcessOnce(task.id, jobId, "slideshow");

  try {
    const st = await getMergerSlideshow(jobId);
    await applyMergerState(task.id, st);
  } catch (e) {
    const pe = e as ProviderError;
    if ((pe as ProviderError & { mergerTerminal?: boolean }).mergerTerminal) {
      await updateTask(task.id, { status: "failed", error_message: clientSafeError(pe.message) });
    }
  }
  return (await getTask(task.id))!;
}
