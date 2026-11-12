#!/usr/bin/env python3
# اختيار أفضل أدوات AI من مشاريع Show HN الحية (بيانات مفتوحة بلا مفاتيح) + بناء سيناريو خام
# الاستخدام: python3 hn_pick_tools.py > tools.json  → يُغذي سكربت الفيديو تلقائيًا
import json, time, urllib.request

SINCE = int(time.time()) - 30 * 24 * 3600
URL = ("https://hn.algolia.com/api/v1/search?query=AI&tags=show_hn"
       f"&numericFilters=created_at_i>{SINCE},points>1&hitsPerPage=50")

req = urllib.request.Request(URL, headers={"User-Agent": "ai-tools-video-pipeline"})
hits = json.load(urllib.request.urlopen(req, timeout=30)).get("hits", [])

KEYS = ("tool", "tools", "directory", "platform", "agent", "assistant")
tools = []
for h in hits:
    t = (h.get("title") or "").replace("Show HN:", "").replace("Show HN", "").strip()
    tl = t.lower()
    if any(k in tl for k in KEYS) and "hiring" not in tl:
        tools.append({"title": t, "points": h.get("points", 0), "url": h.get("url") or ""})

tools.sort(key=lambda x: -x["points"])
tools = tools[:5]

lines = ["أهلاً بكم في جديد أدوات الذكاء الاصطناعي، مختارة من مشاريع حقيقية أطلقها مطورون حول العالم هذا الشهر."]
for i, t in enumerate(tools, 1):
    lines.append(f"الأداة رقم {i}: {t['title']}.")
lines.append("هذا كان موجز الجديد، تابعونا كل أسبوع.")
narration = " ".join(lines)

print(json.dumps({"fetched_at": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
                  "tools": tools, "narration_raw": narration}, ensure_ascii=False))
