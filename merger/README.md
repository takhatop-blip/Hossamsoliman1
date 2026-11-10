# خدمة دمج الفيديوهات على Vercel — Video Merger API

موقع كامل لدمج الفيديوهات مع **واجهة API عامة للمطورين** — Node.js خالص (CommonJS) بلا Next.js: واجهة ثابتة في `public/` + دوال Vercel Serverless في `api/`، وكل التخزين في **Turso** (بيانات المهام + أجزاء المصادر + الفيديو الناتج كـ Blobs). بلا S3 وبلا أي ملف محلي دائم.

هذا المشروع هو نفسه `MERGER_API_BASE` الذي يستخدمه خادم MCP في جذر المستودع.

## الميزات

- **واجهة عربية RTL** ثيم داكن حديث بتدرجات سماوي/بنفسجي: روابط + سحب وإفلات ملفات (mp4/mov/webm/mkv/avi/m4v/mpg/3gp) + إعادة ترتيب بالسحب أو أزرار ↑↓ (ترتيب القائمة = ترتيب الدمج) + شريط تقدم حقيقي من تقدم الخادم + إعادة محاولة ×3 لأي جزء رفع يفشل + نتيجة بمشغل وحجم/مدة/دقة وتحميل ونسخ وعدّاد تنازلي 24 ساعة + توثيق API قابل للطي بأمثلة curl بالدومين الحقيقي + استئناف العرض عبر `#job=<id>`.
- **API عامة** بلا تسجيل دخول وCORS مفتوح والأخطاء بصيغة `{"error":"..."}` برسائل عربية وأكواد صحيحة (400/404/409/413/405).
- **جودة عالية إلزامية**: ffprobe لكل مصدر ← توحيد عبر filter_complex (scale+pad لأكبر دقة بين المدخلات بحد 1920×1080 وأبعاد زوجية، fps=30، setsar=1، yuv420p، concat) ← مصدر بلا صوت يأخذ مسارًا صامتًا `anullsrc` بنفس مدته ← libx264 **CRF 18** + AAC 192k/44100 + `+faststart`. الناتج MP4 ثابت (لا معاملات resolution/fps).
- **تقدم حقيقي**: 0–40 سحب المصادر (فحص الحجم أثناء التنزيل بالبايتات)، 40–90 ترميز (قراءة `out_time_us` من `-progress pipe:1` مقابل المدة الإجمالية)، 100 اكتمال — يُخزَّن في القاعدة كل تحديث.
- **تخزين Blobs مقسّم**: صفوف 2MB (حد HTTP في Turso) تُقرأ بصفحات من 8 صفوف، وبث الناتج يدعم **Range (206 + Content-Range)** لتقليم أول/آخر جزء حسب المدى.
- **حذف تلقائي بعد 24 ساعة**: تنظيف كسول عند كل إنشاء/دمج + كرون يومي في `vercel.json` + DELETE شامل في batch واحد.

## النشر على Vercel

1. **أنشئ قاعدة Turso** (مجانية):
   ```bash
   turso db create <name>                 # إنشاء
   turso db show <name> --url             # → TURSO_DATABASE_URL
   turso db tokens create <name>          # → TURSO_AUTH_TOKEN
   ```
2. **اربط المستودع بـ Vercel**: Add New → Project → اختر المستودع.
3. **مهم جدًا**: Settings → General → **Root Directory = `merger`** وFramework Preset = **Other**.
4. **Environment Variables** (Production + Preview): `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` (+ الاختيارية أدناه).
5. **Deploy** — `vercel.json` يضبط `maxDuration: 300` لكل الدوال وكرون `/api/cron` يوميًا.
6. جرّب: `curl https://<نطاقك>/api/config` → يجب أن يعيد الحدود وversion.

## توثيق API

| Method | Endpoint | الوظيفة |
|---|---|---|
| POST | `/api/jobs` | إنشاء مهمة دمج |
| POST | `/api/upload?job=<id>&seq=<n>&chunk=<k>` | رفع أجزاء ثنائية ≤4MB (octet-stream) |
| POST | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا → رابط النتيجة (أو `202` إن كانت جارية) |
| GET | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| GET | `/api/jobs/<id>/video` | بث MP4 بدعم Range — `?download=1` للتحميل |
| DELETE | `/api/jobs/<id>` | حذف فوري شامل |
| GET | `/api/config` | الحدود العامة + version |
| GET | `/api/cron` | حذف المهام المنتهية (كرون يومي) |

### أمثلة

```bash
BASE=https://<نطاقك>.vercel.app

# 1) مهمة من روابط
curl -X POST $BASE/api/jobs -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'
# ← 201 {"jobId":"...","status":"queued","statusUrl":"...","processUrl":"...","expiresAt":"..."}

# 2) مهمة بملف مرفوع (تقسيم يدوي 4MB)
curl -X POST $BASE/api/jobs -H "Content-Type: application/json" \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"b.mp4","size":10485760,"mime":"video/mp4"}]}'
# ← 201 مع uploads[] وuploadChunkBytes
curl -X POST "$BASE/api/upload?job=JOB&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" --data-binary @part0.bin

# 3) الدمج (متزامن ~10-60 ثانية)
curl -X POST $BASE/api/jobs/JOB/process
# ← 200 {"status":"done","videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"WxH","expiresAt":"..."}

# 4) الحالة والبث
curl $BASE/api/jobs/JOB
curl -H "Range: bytes=0-1023" $BASE/api/jobs/JOB/video      # ← 206 + Content-Range
curl -o merged.mp4 "$BASE/api/jobs/JOB/video?download=1"

# 5) الحذف
curl -X DELETE $BASE/api/jobs/JOB
```

حالات المهمة: `queued` → (`uploading` عند وجود ملفات) → `processing` → `done` | `failed`.

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | ✅ | — | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | ✅ | — | توكن كتابة |
| `MAX_SOURCES` | — | 10 | أقصى عدد مقاطع |
| `SOURCE_MAX_MB` | — | 200 | حد كل مصدر |
| `OUTPUT_MAX_MB` | — | 150 | حد حجم الناتج |
| `MAX_TOTAL_DURATION_SEC` | — | 600 | مجموع مدد المقاطع |
| `FFMPEG_PRESET` | — | medium | preset لـ libx264 |

## الاختبارات

```bash
npm install
node scripts/test-unit.js   # توليد فيديوهين مختلفي الدقة ← دمج ← دقة/مدة/صوت ← Turso sha256 ← حذف
node server.js              # خادم تطوير يحاكي Vercel (منفذ 3101)
node scripts/test-http.js   # 28 اختبار HTTP كامل ضد الخادم المحلي
```

## حدود الخطة المجانية الواجب معرفتها

- **Vercel Hobby**: مدة الدالة حتى 300 ثانية (Fluid Compute) — الدمج الكبير قد يقترب من الحد؛ حجم الطلب ≈ 4.5MB لذلك الرفع أجزاءً 4MB؛ `/tmp` مؤقت (~512MB) ولا يعتمد عليه بين الطلبات.
- **Turso المجانية**: حد التخزين والقراءات الشهرية (راجع لوحة Turso) — الناتج يُحذف تلقائيًا بعد 24 ساعة فلا يتراكم التخزين.
- رفع ملفات أكبر من 200MB يتطلب رفع `SOURCE_MAX_MB` مع الانتباه لحد مدة الدالة أثناء السحب.
