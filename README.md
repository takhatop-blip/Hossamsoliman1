# MCP Media Generator

خادم **MCP لتوليد الوسائط** + **خدمة دمج فيديو** — مستودع واحد بمشروعين:

| المسار | المشروع | الوصف |
|---|---|---|
| `/` (الجذر) | **MCP Media Generator** | خادم MCP (Next.js App Router) على `/mcp` بخمس أدوات: توليد صور، توليد فيديو بصوت متزامن، دمج مقاطع، تتبع مهام، استرجاع الوسائط — مع لوحة إدارة عربية RTL |
| `/merger` | **Video Merger API** | موقع دمج فيديوهات + API عامة على Vercel (Node.js خالص + ffmpeg + Turso) — هو نفسه `MERGER_API_BASE` الذي يستخدمه خادم MCP |

**المزودون:** kie.ai (المزود الأساسي، مختبر فعليًا) + CometAPI (نقاط مأخوذة من توثيقهم الرسمي) + **Pollinations مجاني بلا مفتاح للصور** (احتياط أخير بالترتيب التسلسلي) — مع **تبديل مفاتيح تسلسلي صارم وتلقائي لا يتوقف أبدًا**.

---

## القواعد الجوهرية (مطبقة ومختبرة)

1. **روابط فقط** — لا يُنزَّل أي ملف وسائط على السيرفر إطلاقًا؛ تُخزَّن روابط النتائج فقط في Turso.
2. **الترتيب التسلسلي الصارم**: أول مفتاح أُضيف يُجرَّب أولًا (`ORDER BY created_at ASC, id ASC`) — ليس round-robin.
3. **لا توقف عند نفاد الرصيد**: 401/403 ⇒ تعطيل تلقائي للمفتاح والانتقال للتالي؛ 402/insufficient ⇒ تعليمه `exhausted` (يبقى في القاعدة ويُعاد تجربته لاحقًا) والانتقال للتالي؛ **نفس المهمة تُستأنف بنفس `task_id`**.
4. **نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح/الرصيد أبدًا** — التعقيم في `clientSafeError`.
5. مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (تهدئة ~45 ثانية) — لو شحنت رصيدًا تكتمل من تلقاء نفسها.
6. أخطاء خدمة الدمج المعلنة (HTTP 4xx/5xx) = فشل حتمي فوري؛ أخطاء شبكتنا = مؤقتة.
7. **ملفات الدمج تُحذف بعد 24 ساعة** — مذكورة في وصف الأداة وSERVER_INSTRUCTIONS وواجهة الويب.
8. إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`: أول 7 + `••••••••` + آخر 4).
9. لا أسرار في Git: `.env*` مستثنى منذ أول commit.

---

## 1) التشغيل المحلي (خادم MCP)

```bash
# 1) انسخ .env.example إلى .env.local واملأ القيم (Turso + MERGER_API_BASE)
cp .env.example .env.local

# 2) ثبّت وشغّل
npm install        # أو bun install
npm run dev        # http://localhost:3000

# 3) أضف مفتاح kie.ai من الواجهة (مدير المفاتيح) أو بالـ API:
curl -X POST http://localhost:3000/api/keys \
  -H 'Content-Type: application/json' \
  -d '{"provider":"kie","api_key":"<مفتاحك>","label":"رئيسي"}'
```

### اختبار MCP بـ curl

```bash
# تهيئة جلسة
curl -s -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl-test","version":"1.0"}}}'
# ← خذ mcp-session-id من الترويسة ثم أرسل notifications/initialized ثم tools/list
```

### الأدوات الست

| الأداة | الوصف |
|---|---|
| `generate_image` | توليد صورة بـ `gpt-image-2-6/flare-text-to-image` — تعيد رابطًا جاهزًا أو `task_id` |
| `generate_video` | توليد فيديو بـ `grok-imagine-video-1-5-preview` (صوت متزامن أصلي + image-to-video اختياري) — `task_id` يتابَع بـ `get_task` |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` أو `task_ids` لمهام مكتملة |
| `generate_narrated_video` | **فيديو تعليق مصوّر**: صور (روابط أو أوصاف تُولَّد تلقائيًا) + نص راوي TTS مجاني (عربي افتراضيًا) أو رابط صوت جاهز — الصور تُعرض بالترتيب وتوقيتها يتبع طول الصوت |
| `get_task` | تتبع أي مهمة (توليد أو دمج أو تعليق مصوّر) — حدّثها كل ~10 ثوانٍ حتى اكتمالها |
| `list_media` | أحدث الوسائط المخزنة بروابطها من قاعدة البيانات |

صيغ الموديل البديلة مقبولة (`gpt-image-2.6/...`, `grok-imagine-video-1.5-preview`) وتُوحَّد تلقائيًا، وقابلة للتجاوز بمتغيرات البيئة.

> **ملاحظة موثقة (تم التحقق من الكتالوج الحي `api.cometapi.com/api/models` في 2026-11-12):** معرّفا الموديلات الرسميان لدى CometAPI هما `gpt-image-2.5-flare` (نقطة `/v1/images/generations`) و`grok-imagine-video` (نقطة `/grok/v1/videos/generations` + استعلام `GET /grok/v1/videos/{request_id}`) — نرسلهما كما هي في الكتالوج حسب القاعدة الذهبية (لا اختراع أشكال APIs)، والاسمَان قابلان للتجاوز بـ `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL`.

---

## 2) خدمة الدمج (مجلد merger/)

- **Node.js خالص (CommonJS)** بلا Next.js: دوال Vercel Serverless في `api/` + واجهة ثابتة في `public/` + منطق في `lib/`.
- التخزين: كل شيء في **Turso** — بيانات المهام وأجزاء المصادر والفيديو الناتج (Blobs مقسّمة صفوفًا 2MB تُقرأ بصفحات 8 صفوف). لا S3 ولا ملفات محلية.
- المحرك: `ffmpeg-static` + `ffprobe-static` داخل الدالة (مع `ensureExecutable` تنسخ الثنائي إلى /tmp بصلاحية 755).
- التوحيد: `filter_complex` بـ scale+pad إلى **أكبر دقة بين المدخلات** (حد 1920×1080، أبعاد زوجية)، fps=30، setsar=1، yuv420p، ثم concat — ومصدر بلا صوت يُعطى مسارًا صامتًا `anullsrc` بنفس مدته.
- الترميز: libx264 **CRF 18** + AAC 192k/44100 + `+faststart` ⇒ MP4 يعمل فورًا على الويب. الناتج **ثابت** (لا معاملات resolution/fps).
- تقدم دقيق: 0–40 سحب المصادر (بفحص حجم أثناء التنزيل بالبايتات)، 40–90 ترميز (قراءة `out_time_us` من `-progress pipe:1`)، 100 اكتمال.

### تشغيل محلي واختبار

```bash
cd merger
cp .env.example .env      # املأ قيمتي Turso
npm install
node scripts/test-unit.js # 11 اختبار وحدة: دقة/مدة/صوت/sha256/حذف
node server.js            # خادم تطوير على 3101 يحاكي Vercel (يحلل المسارات الديناميكية)
node scripts/test-http.js # 28 اختبار HTTP: دمج/بث Range 206/مهمة مختلطة/حذف/404/400/413
```

### نقاط API (CORS مفتوح، الأخطاء `{"error":"..."}` برسائل عربية)

| Method | Endpoint | الوظيفة |
|---|---|---|
| POST | `/api/jobs` | إنشاء مهمة (`{"videos":[...]}` أو `{"sources":[...]}`) → `201` مع `jobId/statusUrl/processUrl/expiresAt` |
| POST | `/api/upload?job=&seq=&chunk=` | رفع أجزاء ثنائية ≤4MB (Content-Type: application/octet-stream) |
| POST | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن) → `{status:"done", videoUrl, downloadUrl, size, duration, resolution}` أو `202` إن كانت جارية |
| GET | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| GET | `/api/jobs/<id>/video` | بث MP4 بدعم **Range (206 + Content-Range)** — `?download=1` للتحميل |
| POST | `/api/slideshow` | **(في الكود — النسخة المنشورة لا تتضمنها بعد)** إنشاء مهمة تعليق مصوّر — المحرك انتقل داخل تطبيق MCP (الجدول التالي) |
| POST | `/api/slideshow/<id>/process` | **(في الكود)** تنفيذ كامل: تنزيل الصور + TTS مجاني + ترميز |
| GET | `/api/slideshow/<id>` | **(في الكود)** حالة مهمة التعليق المصوّر |
| DELETE | `/api/jobs/<id>` | حذف فوري شامل |
| GET | `/api/config` | الحدود العامة + version (فحص الجهوزية) |
| GET | `/api/cron` | حذف المهام المنتهية (كرون يومي + تنظيف كسول عند الإنشاء/الدمج) |

الواجهة (عربية RTL، ثيم داكن بتدرجات سماوي/بنفسجي): إضافة روابط + سحب وإفلات ملفات (mp4/mov/webm/mkv/avi/m4v/mpg/3gp) + إعادة ترتيب بالسحب أو ↑↓ + رفع أجزاء 4MB بإعادة محاولة ×3 + شريط تقدم حقيقي من تقدم الخادم + مشغل نتيجة بحجم/مدة/دقة + عدّاد تنازلي 24 ساعة + توثيق API قابل للطي + استئناف العرض عبر `#job=<id>`.

### محرك التعليق المصوّر الداخلي (تطبيق MCP — يعمل الآن على الإنتاج)

لماذا داخليًا؟ لأن تحديث خدمة الدمج المنشورة يتطلب Redeploy يدويًا بتوكن Vercel (تكامل Git ينشر تطبيق MCP فقط)، فنُقل المحرك (ffmpeg + TTS) إلى تطبيق MCP نفسه لينشر تلقائيًا مع كل push.

| Method | Endpoint (على نطاق تطبيق MCP) | الوظيفة |
|---|---|---|
| POST | `/api/slideshow/<id>/process` | تنفيذ كامل في دالة مستقلة (maxDuration 300): تنزيل الصور → TTS مجاني (Google Translate، تقسيم جمل ≤180 حرف + دمج ffmpeg) → ترميز H.264+AAC → تخزين صفوف 2MB في Turso |
| GET | `/api/slideshow/<id>` | حالة المهمة (status/progress/videoUrl عند الاكتمال) |
| GET | `/api/slideshow/<id>/video` | بث MP4 بدعم **Range (206)** — `?download=1` للتحميل |

- التخزين: جدولا `ss_jobs` و `ss_output_chunks` في نفس قاعدة Turso (بادئة ss_ تفصلها عن جداول الدمج) — الاحتفاظ 24 ساعة مع تنظيف كسول.
- رابط النتيجة يُبنى من `VERCEL_PROJECT_PRODUCTION_URL` (دومين الإنتاج الثابت) — يمكن تجاوزه بـ `PUBLIC_BASE_URL`.
- المنسّق يطلق المعالجة بنداء ذاتي ثم يقرأ الحالة من قاعدة البيانات مباشرة في كل `get_task` — إن سقطت الدالة تُعاد المعالجة تلقائيًا.

---

## 3) النشر على Vercel — خطوة بخطوة

### أ) إنشاء قاعدة Turso مجانًا

```bash
# ثبتturso CLI ثم:
turso db create hossam                        # إنشاء القاعدة
turso db show hossam --url                    # ← TURSO_DATABASE_URL (شكلها libsql://...)
turso db tokens create hossam                 # ← TURSO_AUTH_TOKEN (بصلاحيات كتابة)
```

ملاحظة: شكل `turso://` و`libsql://` كلاهما مقبول في `TURSO_DATABASE_URL`.

### ب) نشر خادم MCP (الجذر)

1. ارفع المستودع إلى GitHub (تم — انظر أدناه).
2. في Vercel: **Add New → Project** → اختر المستودع → الإعدادات الافتراضية (سيكتشف Next.js تلقائيًا).
3. **Settings → Environment Variables** أضف (Production + Preview):
   - `TURSO_DATABASE_URL` = رابط القاعدة
   - `TURSO_AUTH_TOKEN` = التوكن
   - `MERGER_API_BASE` = نطاق مشروع الدمج (بعد نشره في الخطوة ج، مثل `https://your-merger.vercel.app`)
   - (اختياري) `MCP_ACCESS_TOKEN` لحماية `/mcp`
4. **Deploy**. لا ملفات محلية إطلاقًا — libSQL يتصل عبر HTTP ومناسب للـ serverless.

### ج) نشر خدمة الدمج (merger/)

1. في Vercel: **Add New → Project** → نفس المستودع.
2. قبل الضغط على Deploy: **Settings → General → Root Directory** = `merger`.
3. Framework Preset = **Other**. Build Command اتركه فارغًا.
4. Environment Variables: `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (نفس القاعدتين أو قاعدة منفصلة إن أردت).
5. **Deploy**. `vercel.json` داخل المجلد يضبط `maxDuration: 300` لكل الدوال + كرون يومي `/api/cron` الساعة 3 فجرًا.
6. خذ نطاق المشروع وضعه في `MERGER_API_BASE` لمشروع MCP ثم أعد النشر (Redeploy).

> ⚠️ **مهم — عطّل حماية النشر في Vercel (Deployment Protection):**
> افتراضيًا تُحمي Vercel كل عمليات النشر بـ *Vercel Authentication* فتُعاد توجيه أي طلب مجهول (302) إلى صفحة تسجيل دخول، وبالتالي يفشل اتصال خادم MCP بخدمة الدمج حتى لو كان النشر سليمًا. الحل بعد أول نشر:
> **Project → Settings → Deployment Protection → Vercel Authentication = Disabled** (احفظ ثم أعد النشر إن لزم).
> وللحصول على نطاق ثابت لا يتغير مع كل نشر: **Deployments → ⋯ → Promote to Production** واستخدم نطاق الإنتاج في `MERGER_API_BASE`.
> اختبار سريع: `curl -s $MERGER/api/config` يجب أن يعيد JSON — إن ظهرت `Protected by Vercel Authentication` فالحماية ما زالت مفعّلة.

### د) التجربة بعد النشر بـ curl

```bash
BASE=https://your-mcp-app.vercel.app
MERGER=https://your-merger.vercel.app

# جهوزية
curl $BASE/api/health
curl $MERGER/api/config

# أدوات MCP
curl -s -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# ثم tools/list و tools/call بنفس نمط الاختبار أعلاه مع ترويسة mcp-session-id

# دمج مباشر عبر خدمة الدمج
JOB=$(curl -s -X POST $MERGER/api/jobs -H 'Content-Type: application/json' \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}' | jq -r .jobId)
curl -s -X POST $MERGER/api/jobs/$JOB/process
curl -s -o merged.mp4 "$MERGER/api/jobs/$JOB/video?download=1"
```

### ربط أي عميل MCP

| العميل | التكوين |
|---|---|
| ChatGPT (Connectors) | Settings → Connectors → Create → Custom MCP server → Server URL = `<origin>/mcp` — JSON: `{"mcpServers":{"media-generator":{"url":"<MCP_URL>"}}}` |
| Claude Desktop | ملف `claude_desktop_config.json`: `{"mcpServers":{"media-generator":{"type":"http","url":"<MCP_URL>"}}}` |
| Cursor / Windsurf / Cline | ملف `mcp.json` بنفس صيغة ChatGPT |

إن ضُبط `MCP_ACCESS_TOKEN` أضف `"headers": {"Authorization": "Bearer <token>"}` — الواجهة تعرض JSON جاهزًا للنسخ لكل عميل.

---

## 4) متغيرات البيئة

| المتغير | أين | إلزامي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | الجذر + merger | ✅ | رابط قاعدة Turso (`libsql://...`) |
| `TURSO_AUTH_TOKEN` | الجذر + merger | ✅ | توكن بصلاحيات كتابة |
| `MERGER_API_BASE` | الجذر | ✅ | نطاق خدمة الدمج المنشورة |
| `MCP_ACCESS_TOKEN` | الجذر | — | حماية `/mcp` بـ Bearer token |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | الجذر | — | تجاوز أسماء موديلات kie.ai |
| `POLLINATIONS_IMAGE_MODEL` | الجذر | — | تجاوز موديل Pollinations (الافتراضي `flux`) |
| `POLLINATIONS_API_BASE` | الجذر | — | تجاوز عنوان Pollinations للاختبار |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | الجذر | — | تجاوز أسماء موديلات CometAPI |
| `MAX_SOURCES` | merger | — | حد المقاطع (10) |
| `SOURCE_MAX_MB` | merger | — | حد حجم كل مصدر (200MB) |
| `OUTPUT_MAX_MB` | merger | — | حد حجم الناتج (150MB) |
| `MAX_TOTAL_DURATION_SEC` | merger | — | مجموع المدد (600 ث) |
| `FFMPEG_PRESET` | merger | — | سرعة/جودة x264 (medium) |

---

## 5) حدود الخطط المجانية التي يجب معرفتها

- **Vercel Hobby**: مدة الدالة حتى **300 ثانية** مع Fluid Compute (`maxDuration: 300` في merger/vercel.json)؛ حجم الطلب ≈ **4.5MB** لذلك الرفع أجزاءً 4MB؛ `/tmp` مؤقت فقط (~512MB) ولا نظام ملفات دائم.
- **Turso المجانية**: تخزين يكفي للفيديوهات المدمجة الصغيرة/المتوسطة (راجع الحد الحالي في لوحة Turso — كان ~5GB) وعدد صفوف/قراءات شهري؛ الناتج يُحذف تلقائيًا بعد 24 ساعة فلا يتراكم.
- **kie.ai**: الدفع حسب الاستهلاك (الصورة ≈ 8 كريدت، الفيديو ≈ 19 كريدت في قياسنا) — أضف عدة مفاتيح ليتولى السيرفر التبديل تلقائيًا.
- **Pollinations (مجاني بلا مفتاح)**: للصور فقط — يُجرَّب تلقائيًا في آخر الترتيب التسلسلي بعد كل المفاتيح المدفوعة، فلو نفدت الأرصدة تستمر الصور بالمجان بلا أي تدخل. لا يُخزَّن أي وسيط على السيرفر — يُعاد رابط التوليد نفسه (نفس prompt+seed يُنتج الصورة عبر كاش الخدمة). حدّه المقاس حيًا (2026-11-12): **صورة واحدة كل 45 ثانية لكل IP** (402 + رسالة Retry after Ns — يعالجها السيرفر بانتظار ذكي). يُفضَّل تمرير روابط صور جاهزة في `generate_narrated_video` لتجاوز الانتظار.
- **صوت الراوي (TTS)**: Google Translate TTS مجاني بلا مفتاح (≤200 حرف/طلب — النص يُقسَّم على حدود الجُمل وتُدمج الأجزاء بـ ffmpeg تلقائيًا، الحد 8000 حرف). ملاحظة قياسية: StreamElements أصبح يتطلب توثيقًا (401) وPollinations الصوتية مدفوعة (402) — لذلك Google هو المزود المعتمد.

### الحصول على رصيد CometAPI التجريبي المجاني

1. سجّل حسابًا في [cometapi.com](https://www.cometapi.com) (بريد إلكتروني أو Google — لا تُطلب بطاقة للتسجيل).
2. يظهر رصيد ترحيبي **$0.10** تلقائيًا في صفحة Wallet بعد التسجيل (بدون خطوات إضافية).
3. أنشئ API Key من قائمة **Tokens** على اليسار → **Add Token** → اسم من اختيارك وانسخه.
4. في لوحة هذا المشروع (إدارة المفاتيح) اختر المزود **CometAPI** وألصق المفتاح — سيتولى السيرفر استخدامه فورًا حسب الترتيب التسلسلي.
   - الموديلات المُرسلة فعليًا هي `gpt-image-2.5-flare` و`grok-imagine-video` (كما في كتالوجهم الحي).
   - **حدّ الرصيد المجاني**: $0.10 تكفي لصورة اختبار واحدة تقريبًا ولا تكفي لفيديو (يُحاسب بالثانية: 480p ≈ $0.05/ث) — التعبئة الدنيا $10 عبر Stripe. للاختبار المجاني الحقيقي للصور اعتمد على Pollinations (يعمل تلقائيًا بلا مفتاح).

---

## 6) ما الذي اختُبر فعليًا (نتائج حقيقية)

- ✅ **kie.ai حقيقي**: `createTask` صورة → نجاح (7.84 كريدت) ورابط PNG يعمل؛ فيديو grok → نجاح (19.2 كريدت) ورابط MP4 يعمل — الأشكال كما في هذا المستودع حرفيًا (منها `resultJson` النصي الذي يحتاج `JSON.parse` ثانيًا).
- ✅ **التبديل التسلسلي e2e**: مفتاح خاطئ أولًا ⇒ 401 ⇒ `disabled` تلقائيًا؛ المفتاح الحقيقي نفد رصيده ⇒ `exhausted` (بقي في القاعدة)؛ المهمة بقيت `processing` برسالة عربية نظيفة ثم **اكتملت بنفس task_id** عند توفر مورد صالح — العميل لم يرَ أي ذكر لمفاتيح/رصيد.
- ✅ **MCP**: initialize (session id + SERVER_INSTRUCTIONS) / tools/list (الأدوات الخمس بالمخططات المطلوبة، دمج بلا resolution/fps وبحد 10) / tools/call لكل الأدوات برسائل عربية.
- ✅ **الدمج e2e عبر MCP**: مقطعان عامان → MP4 نهائي H.264+AAC على نطاق خدمة الدمج (مدة 20.03 ث ≈ مجموع المقطعين، Range 206 يعمل) + تحذير 24 ساعة في الرد.
- ✅ **رفض الدمج**: مقطع واحد وأكثر من 10 برسائل عربية، وحل `task_ids` بالترتيب.
- ✅ **merger**: 11 اختبار وحدة + 28 اختبار HTTP (الدقة=أكبر دقة، المدة=المجموع، صوت، sha256 للتخزين، رفع أجزاء، 413، حذف شامل، 404، 400).
- ✅ **الواجهة** (متصفح حقيقي): RTL عربية، إضافة/تعطيل/حذف مفتاح، لوحة مهام تتحدث كل 5 ثوانٍ، JSON ربط لكل تبويب.
- ✅ **Pollinations e2e حي (2026-11-12)**: `generate_image` عبر MCP على النسخة المنشورة مع مفتاح kie مستنزف ولا مفتاح cometapi ⇒ نجحت الصورة خلال ~10 ثوانٍ عبر Pollinations المجاني تلقائيًا (JPEG 1024×1024، الرابط يعيد الصورة فعليًا HTTP 200 image/jpeg) — احتياط المزود الأخير يعمل كما صُمم.
- ✅ **التعليق المصوّر — المحرك الداخلي (2026-11-12)**: نُقل المحرك (TTS + ffmpeg) داخل تطبيق MCP لينشر تلقائيًا مع كل push — بدل الاعتماد على خدمة الدمج (نسخة merger المنشورة بلا نقاط `/api/slideshow` وتفشل بـ 404، وهذا هو سبب النقل). **E2E كامل على خادم MCP محلي مبني من نفس الكود**: نداء `generate_narrated_video` عبر MCP (initialize → tools/call) ⇒ رابط فيديو خلال 3 ثوانٍ ⇒ MP4 h264 854×480 + AAC ستيريو بصوت راوي حقيقي (متوسط ‎-22.7dB) مدته 8.45 ث مطابقة للصوت، بث Range 206 يعمل (`bytes 0-1023/223385`)، ونقطة الحالة تعيد `{status:"done", duration, resolution}` — و`next build` ينجح بكل مسارات `/api/slideshow/*`. النتيجة الحية على الإنتاج تُوثَّق بعد الدفع.
- ✅ **النشر الحي + E2E على الإنتاج (2026-11-13)**: نُشرت آخر التحديثات على `https://hossamsoliman1.vercel.app` (التزام `f3f3018`، نشر Vercel ناجح خلال ~دقيقة). النتائج المقاسة: `/api/health` يعيد `ok:true` مع `turso-connected`، مفتاح kie.ai أُضيف عبر `POST /api/keys` وظهر مقنّعًا (`fb4cccf••••••••b315`) بحالة `active`. **E2E حي كامل للتعليق المصوّر على الإنتاج**: 5 صور مخبوزة في نشر Vercel نفسه (`/demo_img_1..5.jpg` — حل مشكلة تقلب picsum الذي أرجع 522 حتى من خوادم Vercel) + سيناريو عربي حقيقي (جولة أدوات AI من بيانات Hacker News الحية) ⇒ المهمة `fbf1c0c9` اكتملت من أول استقصاء ⇒ MP4 حقيقي 96 ثانية، 854×480، h264 + AAC ستيريو، صوت راوٍ عربي حقيقي (متوسط ‎-22.3dB)، بث Range يعيد **206**، والرابط: `/api/slideshow/fbf1c0c9-65e1-4000-9f7a-bd3c355ca1b9/video`. سكربت الاختبار الحي: `scripts/live_prod_e2e.sh`.
- ✅ `tsc --noEmit` نظيف + `next build` ينجح + ESLint نظيف.

## 7) بنية المستودع

```
├── src/
│   ├── lib/                 # turso.ts · keys.ts · models.ts · merger.ts · orchestrator.ts
│   │   ├── providers/       # types.ts · kie.ts · cometapi.ts · pollinations.ts
│   │   └── slideshow/       # ffmpeg.ts · tts.ts · builder.ts · jobs.ts · base.ts (محرك التعليق الداخلي)
│   └── app/
│       ├── mcp/route.ts     # خادم MCP (SDK رسمي: McpServer + WebStandardStreamableHTTP)
│       ├── api/health       # جهوزية + فحص خدمة الدمج
│       ├── api/keys[/id]    # إدارة المفاتيح (إخفاء إلزامي)
│       ├── api/tasks        # لوحة المهام (مهام + إحصائيات)
│       ├── layout.tsx       # RTL عربية + خط Cairo
│       └── page.tsx         # لوحة الإدارة الثلاثية
├── merger/                  # مشروع دمج مستقل (Node خالص + Vercel functions)
│   ├── api/  lib/  public/  scripts/  vercel.json
├── scripts/mock-kie.js      # مزود وهمي لاختبارات التبديل (اختياري)
└── README.md
```

## 8) أمان

- لا مفاتيح في الكود أو Git — المفاتيح تُدار من الواجهة وتُخزَّن في Turso وتُخفى في كل الاستجابات.
- `.env*` مستثنى من Git منذ اليوم الأول (`.env.example` فقط قالب بلا قيم).
- ننصح **بتدوير** أي مفاتيح شاركت في محادثات أو لقطات شاشة، وضبط `MCP_ACCESS_TOKEN` عند النشر العلني.
