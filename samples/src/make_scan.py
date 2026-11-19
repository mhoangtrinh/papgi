from PIL import Image, ImageFilter
import random
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
random.seed(7)
im = Image.open("scan_raw.png").convert("L")
im = im.rotate(-0.8, resample=Image.BICUBIC, expand=False, fillcolor=255).filter(ImageFilter.GaussianBlur(0.6))
px = im.load()
w, h = im.size
for _ in range(w * h // 2500):
    x, y = random.randrange(w), random.randrange(h)
    px[x, y] = max(0, px[x, y] - random.randrange(40, 120))
im = im.point(lambda v: int(v * 0.92 + 8))
im.save("scan.jpg", quality=70)
c = canvas.Canvas("../../public/samples/scan.pdf", pagesize=A4)
c.drawImage("scan.jpg", 0, 0, *A4)
c.showPage(); c.save()
