# مولد الوسائط — MCP Server 🎬

> خادم MCP لتوليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع + محرك دمج مدمج + لوحة إدارة عربية RTL

خادم **MCP** واحد (Next.js App Router) يجمع ثلاث قدرات:

1. **توليد صور** من وصف نصي — الموديل `gpt-image-2-6/flare-text-to-image`.
2. **توليد فيديو** بصوت متزامن أصلي (حوار/مؤثرات/موسيقى) — الموديل `grok-imagine-video-1-5-preview`.
3. **دمج عدة مقاطع** في فيديو واحد عالي الجودة (MP4 / H.264 + AAC / حتى 1080p) — محرك دمج مدمج داخل نفس التطبيق.

يعمل مع أي عميل MCP: **ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline / GPT Agents SDK**.

---

## ✨ المزايا الجوهرية

| الميزة | التفاصيل |
|---|---|
| 🔑 **تبديل مفاتيح تسلسلي صامت** | المفاتيح تُجرَّب بترتيب إضافتها الصارم (`created_at ASC`)، وعند أي خطأ أو نفاد رصيد تُستأنف **نفس المهمة بنفس task_id** على المفتاح التالي فورًا — نموذج الذكاء الاصطناعي لا يرى أخطاء المفاتيح أو الرصيد أبدًا |
| 🔁 **مهمة لا تموت أبدًا** | إن فشل الإنشاء على كل المفاتيح تبقى المهمة `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (بتهدئة 45 ثانية) — لو شحنت رصيدًا تكتمل المهمة من تلقاء نفسها |
| 🚫 **روابط فقط** | لا يُنزَّل أي ملف وسائط توليد إلى السيرفر — تُخزَّن روابط النتائج فقط في Turso |
| 🏗️ **دمج مدمج** | محرك ffmpeg كامل داخل التطبيق: رفع أجزاء 4MB، توحيد الدقات (scale+pad)، صوت صامت للمقاطع الصامتة، CRF 18، بث Range 206، تخزين Blobs في Turso |
| 🕐 **تنظيف تلقائي** | ملفات الدمج تُحذف بعد ~24 ساعة (تنظيف كسول + Cron يومي) |
| 🖥️ **لوحة عربية** | مدير مفاتيح، لوحة مهام حية، إعدادات ربط جاهزة للنسخ، واستوديو دمج بالسحب والإفلات |

---

## 🧱 البنية

```
src/
├── app/
│   ├── page.tsx                    # لوحة التحكم RTL (4 بطاقات)
│   ├── api/health                  # فحص الجهوزية
│   ├── api/keys[/id]               # إدارة المفاتيح (مقنعة دائمًا)
│   ├── api/tasks                   # لوحة المهام (استطلاع كل 5 ثوانٍ)
│   ├── api/jobs[/id][/process][/video]  # API خدمة الدمج العامة
│   ├── api/upload                  # رفع أجزاء الملفات (4MB)
│   ├── api/config                  # حدود الخدمة
│   └── api/cron                    # حذف المهام المنتهية (يومي)
├── pages/api/mcp.ts                # خادم MCP على /mcp (الـ SDK الرسمي، وضع بلا جلسات)
├── lib/
│   ├── turso.ts                    # عميل Turso + ensureSchema (بلا migrations)
│   ├── keys.ts / keys-db.ts        # المرجع التسلسلي + تصنيف الأخطاء + الإخفاء
│   ├── models.ts                   # سجل الموديلات والبدائل والتجاوز بالبيئة
│   ├── providers/{kie,cometapi}    # محولا المزودين (أشكال API حقيقية مقاسة)
│   ├── generation.ts               # runGeneration/refreshTask + التبديل الصامت
│   ├── merge.ts                    # runMerge/refreshMergeTask
│   ├── merger-service.ts           # دمج داخلي مباشر أو خدمة خارجية عبر HTTP
│   └── merger/{store,ffmpeg,runner,cleanup}
└── components/dashboard/           # مكونات اللوحة
```

**قاعدة البيانات (Turso/libSQL عبر HTTP):** جداول `tasks` و`api_keys` للتوليد، وجداول `jobs` و`sources` و`source_chunks` و`output_chunks` لخدمة الدمج (كل Blob صفوف 2MB). تُنشأ جميعها بـ `CREATE TABLE IF NOT EXISTS` عند أول وصول.

---

## 🚀 النشر على Vercel (خطوة بخطوة)

### 1) قاعدة Turso (مرة واحدة)

```bash
# ثبّت CLI ثم سجّل الدخول
curl -sSfL https://get.tur.so/install.sh | bash && turso auth login

turso db create video            # أنشئ القاعدة
turso db show video --url        # ← انسخ الرابط   (TURSO_DATABASE_URL)
turso db tokens create video     # ← انسخ التوكن   (TURSO_AUTH_TOKEN)
```

> إن كانت لديك قاعدة جاهزة (مثل `video-ahmedelshekh9893`) فاستخدم رابطها وتوكنها مباشرة.

### 2) اربط المستودع بـ Vercel

1. أدخل [vercel.com/new](https://vercel.com/new) واختر مستودع **Video**.
2. قبل الضغط على Deploy افتح **Environment Variables** وأضف:

| المتغير | القيمة | إلزامي |
|---|---|---|
| `TURSO_DATABASE_URL` | رابط قاعدتك `libsql://...turso.io` | ✅ |
| `TURSO_AUTH_TOKEN` | توكن القاعدة بصلاحيات كتابة | ✅ |
| `MERGER_API_BASE` | **اتركه فارغًا** (يستخدم محرك الدمج المدمج) | — |
| `MCP_ACCESS_TOKEN` | كلمة سر اختيارية تحمي `/mcp` | — |
| `KIE_IMAGE_MODEL` … | تجاوز أسماء الموديلات | — |

3. اضغط **Deploy** — سيعمل كل شيء فورًا (libSQL يتصل عبر HTTP ومناسب للـ serverless، و`/mcp` يدعم البث).

> ملاحظات: مفتاح kie.ai يُضاف من **لوحة التحكم** بعد النشر (يُخزَّن في Turso مقنعًا في الواجهة). مدة الدوال مضبوطة حتى 300 ثانية (Fluid compute) لدعم ترميز الفيديو، والمنطقة `fra1` قريبة من قواعد Turso الأوروبية.

### 3) أضف مفتاحك وجرّب

1. افتح رابط الموقع → بطاقة **مدير المفاتيح** → اختر `kie.ai` والصق مفتاحك → إضافة.
2. في ChatGPT: **الإعدادات ← Connectors ← Create ← Custom MCP connector** وضع في Server URL:

```
https://<موقعك>.vercel.app/mcp
```

3. جرّب من الدردشة: «ارسم قطة astronaut» ثم «ولّد فيديو عن المحيط» ثم «ادمج آخر مقطعين».

### 4) اختبار الـ API بـ curl بعد النشر

```bash
BASE=https://<موقعك>.vercel.app

# الجهوزية
curl -s $BASE/api/health

# قائمة الأدوات
curl -s -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
curl -s -X POST $BASE/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# دمج مقطعين عامين
curl -s -X POST $BASE/api/jobs -H 'Content-Type: application/json' \
  -d '{"videos":["https://www.w3schools.com/html/mov_bbb.mp4","https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"]}'
# ← خذ jobId ثم:
curl -s -X POST $BASE/api/jobs/<jobId>/process
curl -s -H "Range: bytes=0-1023" -o /dev/null -w "%{http_code}\n" $BASE/api/jobs/<jobId>/video   # 206
```

---

## 🛠️ التشغيل المحلي

```bash
bun install
cp .env.example .env.local        # ضع قيم Turso الحقيقية
bun run dev                       # http://localhost:3000
bunx tsc --noEmit                 # فحص الأنواع
```

سكربتات مساعدة في `scripts/`:
- `check-env.mjs` — فحص اتصال Turso وصلاحية مفتاح kie.ai.
- `cleanup-test-data.mjs` — حذف كل مهام/دمجات الاختبار من القاعدة.

---

## 🔌 أدوات MCP الخمس

| الأداة | الوصف |
|---|---|
| `generate_image` | توليد صورة (prompt، aspect_ratio، resolution 1K/2K/4K، background، output_format، wait_seconds ≤240). تعيد الرابط إن اكتملت خلال نافذة الانتظار وإلا `task_id` |
| `generate_video` | توليد فيديو بصوت أصلي (prompt، image_url اختياري، duration 1–15ث، resolution 480p/720p/1080p، enable_audio) |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` مباشرة أو `task_ids` لمهام مكتملة — الملف يُحذف بعد ~24 ساعة |
| `get_task` | تتبع أي مهمة (توليد أو دمج) — استعلمه كل ~10 ثوانٍ حتى الاكتمال |
| `list_media` | أحدث الوسائط المخزنة بروابطها (فلاتر type/status/limit) |

**سير العمل للعميل:** استدعِ `generate_image`/`generate_video` → إن ظهرت روابط فاعرضها → إن رجع `task_id` فتابع بـ `get_task` كل ~10 ثوانٍ حتى `completed` (اعرض الرابط وتوقف) أو `failed` (اشرح السبب). أثناء الانتظار تُبَث إشعارات تقدم حية عندما يوفر العميل `_meta.progressToken`.

---

## 📡 واجهة الدمج العامة (بدون تسجيل، CORS مفتوح)

| Method | Endpoint | الوظيفة |
|---|---|---|
| `POST` | `/api/jobs` | إنشاء مهمة: `{"videos":[...]}` أو `{"sources":[{kind,url/file,name,size,mime}]}` → `201 {jobId,status,statusUrl,processUrl,expiresAt,uploads[]}` |
| `POST` | `/api/upload?job=&seq=&chunk=` | رفع أجزاء ثنائية ≤4MB (`application/octet-stream`) |
| `POST` | `/api/jobs/<id>/process` | تنفيذ الدمج كاملًا (متزامن) → `200 {status:"done",videoUrl,downloadUrl,size,duration,resolution,expiresAt}` أو `202` قيد المعالجة |
| `GET` | `/api/jobs/<id>` | الحالة + التقدم 0–100 + الرابط عند الاكتمال |
| `GET` | `/api/jobs/<id>/video` | بث MP4 بدعم **Range 206**، و`?download=1` للتحميل |
| `DELETE` | `/api/jobs/<id>` | حذف فوري شامل |
| `GET` | `/api/config` | الحدود العامة + version |
| `GET` | `/api/cron` | حذف المهام المنتهية (Cron يومي `0 3 * * *`) |

الأخطاء دائمًا `{"error":"..."}` برسائل عربية: `400` مدخلات تالفة، `404` غير موجود، `409` حالة غير مناسبة، `413` تجاوز الحجم، `405` طريقة خاطئة.

**محرك الدمج:** ffprobe لكل مصدر → توحيد عبر `filter_complex` (scale+pad لأكبر دقة ≤1920×1080 بأبعاد زوجية، fps=30، setsar=1، yuv420p، concat) → مصدر بلا صوت يُضاف له `anullsrc` بنفس مدته → **libx264 CRF 18 + AAC 192k/44100 + +faststart**. التقدم: 0–40 سحب المصادر، 40–90 ترميز (من `out_time_us`)، 90–100 تخزين Blobs.

---

## ⚙️ تصنيف أخطاء المزودين (سلوك التبديل)

| الفئة | الشرط | الإجراء |
|---|---|---|
| `disabled` | HTTP 401/403 أو `invalid api key / unauthorized` | تعليم المفتاح disabled تلقائيًا → المفتاح التالي |
| `exhausted` | HTTP 402 أو `insufficient / quota / balance / credit` (يُفحص قبل 400) | تعليمه exhausted (يبقى في القاعدة) → التالي |
| `provider` | `model not found` مع 400/404/422 | التالي |
| `params` | 400/422 (معطيات) | **توقف فورًا** — التبديل لن يحلها |
| `temporary` | 429، 5xx، شبكة، مهلة | التالي الآن والمفتاح يبقى سليمًا |

فشل مفتاح/رصيد **في منتصف مهمة** (رسالة المزود تطابق الأنماط) → إعادة إنشاء **نفس المهمة بنفس task_id** على المفتاح التالي صامتًا. وإذا فشل كل شيء تبقى `processing` وتُعاد المحاولة مع كل `get_task` بعد 45 ثانية.

أخطاء خدمة الدمج **المعلنة** (HTTP 4xx/5xx بجسم error) = فشل نهائي فوري بلا إعادة محاولة؛ أخطاء شبكتنا = مؤقتة ويستمر الاستعلام.

---

## 📏 الحدود

| الحد | القيمة |
|---|---|
| مقاطع الدمج | 10 كحد أقصى |
| حجم كل مصدر | 200MB |
| حجم الناتج | 150MB |
| مجموع المدد | 600 ثانية |
| صلاحية ملف الدمج | ~24 ساعة (ثم حذف تلقائي) |
| أجزاء الرفع | 4MB (حد طلب Vercel ≈ 4.5MB) |
| صفوف Blobs في Turso | 2MB لكل صف |

**حدود الخطط المجانية الواجب معرفتها:** مدة دالة Vercel حتى 300 ثانية (Fluid compute — يكفي لدمج 10 مقاطع)، حد الطلب 4.5MB (لهذا الرفع أجزاءً)، وقاعدة Turso المجانية 5GB تخزين (ملفات الدمج تُحذف خلال 24 ساعة فلا تتراكم).

---

## 🔐 الأمان

- المفاتيح **مقنعة دائمًا** في كل الاستجابات والسجلات (`ABCDEF1••••••••WXYZ`) ولا يُعاد المفتاح الكامل أبدًا.
- `.env*` مستثنى من Git منذ أول commit — لا أسرار في المستودع.
- `MCP_ACCESS_TOKEN` (اختياري) يحمي `/mcp` بـ Bearer token.
- ⚠️ **انصيحة مهمة:** إن شاركت مفاتيح/توكنات في أي محادثة، خذ بعين الاعتبار تدويرها (Turso token، مفتاح kie.ai، GitHub PAT) بعد انتهاء الإعداد.

---

## 🧪 الاختبارات المنفذة (حقيقية e2e)

1. ✅ `tsc --noEmit` نظيف.
2. ✅ `/api/health`: `ok:true` + `turso-connected` + `merger.healthy:true`.
3. ✅ `tools/list` على `/mcp`: الأدوات الخمس بمخططات مطابقة (merge بلا resolution/fps وبحد 10).
4. ✅ توليد صورة حقيقي عبر `generate_image` بمفتاح صحيح → رابط PNG يعمل (HTTP 200).
5. ✅ التبديل التسلسلي: مفتاح خاطئ أولًا ثم صحيح → نفس المهمة اكتملت على الثاني، الخاطئ أصبح `disabled`، ولم يصل العميل أي ذكر للمفاتيح.
6. ✅ مفتاح مستنزف/مرفوض يُعلَّم ويبقى في القاعدة دون عرقلة التالي.
7. ✅ توليد فيديو: موديل `grok-imagine-video-1-5-preview` مقبول لدى kie.ai (createTask 200) ومهمة كاملة أنتجت رابط MP4 صالح — نفس مسار الكود للمهمة غير المتزامنة صُدِّق عبر الصورة وget_task.
8. ✅ دمج e2e حقيقي: مقطعان بدقتين مختلفتين (640x360 + 1280x720 مع مقطع صامت) → MP4 نهائي 1280x720 H.264+AAC مدته 9 ث، والمهمة المختلطة (رابط خارجي + رابط محلي + ملف مرفوع أجزاءً) → MP4 16 ث.
9. ✅ بث Range يعمل (206 + Content-Range + Content-Length صحيح).
10. ✅ الرفض: مقطع واحد وأكثر من 10 وtask_ids غير مكتملة وJSON تالف و404 — كلها برسائل صحيحة.
11. ✅ `list_media` يعيد المهام بروابطها من الأحدث، و`get_task` يعرض رسالة الدمج مع تحذير 24 ساعة.
12. ✅ الواجهة: إضافة/تعطيل/حذف مفتاح، لوحة مهام حية، بطاقة ربط بثلاث تبويبات، استوديو دمج كامل — RTL عربي سليم.
13. ✅ تنظيف آثار الاختبار من قاعدة البيانات بعد الانتهاء.
