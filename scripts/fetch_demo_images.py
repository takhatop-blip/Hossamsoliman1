#!/usr/bin/env python3
# تنزيل 5 صور حقيقية إلى القرص المحلي (public/) لتخدمها محليًا — يتخطى تقلب الشبكة نهائيًا
# يطبع JSON: قائمة روابط localhost جاهزة لتمريرها لمحرك الفيديو
import json, os, sys, time, urllib.request

PUB = "/home/z/my-project/.next/standalone/public"
PUB_LINK = "/home/z/my-project/public"
os.makedirs(PUB, exist_ok=True)
os.makedirs(PUB_LINK, exist_ok=True)

CANDIDATES = (
    [f"https://picsum.photos/id/{i}/1280/720.jpg" for i in
     (0, 2, 20, 1, 24, 26, 48, 60, 119, 180, 365, 366, 429, 10, 96, 160, 250, 326, 445, 532)]
    + [f"https://image.pollinations.ai/prompt/{p}/1280/720.jpg?seed={s}" for p, s in
       [("futuristic%20AI%20robot", 1), ("artificial%20intelligence%20brain%20circuit", 2),
        ("tech%20startup%20office%20computer", 3), ("robot%20arm%20factory", 4),
        ("digital%20network%20abstract", 5), ("humanoid%20robot%20portrait", 6)]]
)

def valid_image(path):
    try:
        if os.path.getsize(path) < 20000:
            return False
        with open(path, "rb") as f:
            head = f.read(4)
        return head[:3] == b"\xff\xd8\xff" or head[:4] == b"\x89PNG"
    except OSError:
        return False

saved = 0
# تخطٍ سريع: إن كانت 5 صور صالحة محفوظة مسبقًا فلا تنزيل إطلاقًا
already = sum(1 for i in range(1, 6) if valid_image(f"{PUB}/demo_img_{i}.jpg"))
if already >= 5:
    print("  الصور الخمس موجودة مسبقًا — تخطي التنزيل", file=sys.stderr, flush=True)
    saved = 5
for idx, url in enumerate(CANDIDATES):
    if saved >= 5:
        break
    dst = f"{PUB}/demo_img_{saved+1}.jpg"
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "ai-tools-video-demo/1.0"})
            data = urllib.request.urlopen(req, timeout=25).read()
            with open(dst, "wb") as f:
                f.write(data)
            if valid_image(dst):
                saved += 1
                print(f"  saved demo_img_{saved}.jpg ← {url[:70]}", file=sys.stderr, flush=True)
                break
        except Exception as e:
            print(f"  fail[{attempt}] {url[:60]} → {e}", file=sys.stderr, flush=True)
            time.sleep(2)

urls = [f"http://127.0.0.1:8899/demo_img_{i}.jpg" for i in range(1, 6)]
# نسخة مطابقة في public/ العادي للتوثيق
import shutil
for i in range(1, 6):
    src = f"{PUB}/demo_img_{i}.jpg"
    if os.path.exists(src):
        shutil.copyfile(src, f"{PUB_LINK}/demo_img_{i}.jpg")
print(json.dumps(urls))
