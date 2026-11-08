import sys, glob, os
from PIL import Image, ImageDraw, ImageFont
files = sorted(glob.glob(os.path.join(sys.argv[1], "s_*.png")))
cols = 4
w, h = 480, 270
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * w, rows * h), (0, 0, 0))
d = ImageDraw.Draw(sheet)
f = ImageFont.truetype(r"C:\Windows\Fonts\consola.ttf", 18)
for i, p in enumerate(files):
    im = Image.open(p).convert("RGB").resize((w, h))
    x, y = (i % cols) * w, (i // cols) * h
    sheet.paste(im, (x, y))
    d.text((x + 6, y + 4), os.path.basename(p)[2:-4] + "s", fill=(255, 255, 0), font=f)
sheet.save(sys.argv[2])
