from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 250
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "public", "logo-250.png")

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded background with vertical gradient
radius = 52
# gradient colors
top = (79, 70, 229)   # indigo
bot = (124, 58, 237)  # violet

# build gradient mask on a temp image then round corners
grad = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(grad)
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(top[0] + (bot[0] - top[0]) * t)
    g = int(top[1] + (bot[1] - top[1]) * t)
    b = int(top[2] + (bot[2] - top[2]) * t)
    gd.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# rounded mask
mask = Image.new("L", (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=radius, fill=255)
grad.putalpha(mask)
img = Image.alpha_composite(img, grad)

draw = ImageDraw.Draw(img)

# subtle inner highlight ring
draw.rounded_rectangle((10, 10, SIZE - 11, SIZE - 11), radius=radius - 6, outline=(255, 255, 255, 40), width=2)

# Letter R
font_path = "C:/Windows/Fonts/segoeuib.ttf"
font = ImageFont.truetype(font_path, 150)
text = "R"
bbox = draw.textbbox((0, 0), text, font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
x = (SIZE - tw) // 2 - bbox[0]
y = (SIZE - th) // 2 - bbox[1] - 6
draw.text((x, y), text, font=font, fill=(255, 255, 255, 255))

# accent dot (speech bubble tail hint) bottom-right
draw.ellipse((188, 188, 210, 210), fill=(251, 191, 36, 255))  # amber
draw.ellipse((194, 194, 204, 204), fill=(255, 255, 255, 220))

img.save(OUT)
print("saved", OUT)
