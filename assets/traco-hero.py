"""Gera a versao com contorno preto do lettering da hero.

O traco NAO e CSS: a arte e raster com alpha, entao o contorno sai de
uma dilatacao da propria silhueta. MaxFilter(3) cresce 1px por passe,
entao a largura fica exata e previsivel — nada de adivinhar limiar de
borrao, que foi a primeira tentativa e saiu com cara de brilho, nao de
contorno.

    python3 traco-hero.py 2            # raio em px, na escala do arquivo (1005px)
    python3 traco-hero.py 2 000000     # raio + cor do traco em hex (padrao: branco)

Saida: historias-de-atrito-traco.webp, ao lado deste script.
"""
import sys, os
from PIL import Image, ImageFilter

r = int(sys.argv[1]) if len(sys.argv) > 1 else 2
cor_hex = (sys.argv[2] if len(sys.argv) > 2 else 'ffffff').lstrip('#')
cor = tuple(int(cor_hex[i:i+2], 16) for i in (0, 2, 4))
aqui = os.path.dirname(os.path.abspath(__file__))
im = Image.open(os.path.join(aqui, 'historias-de-atrito.webp')).convert('RGBA')

# folga: a arte esta rente ao bbox e o traco seria ceifado nas bordas
pad = r + 6
base = Image.new('RGBA', (im.width + pad*2, im.height + pad*2), (0, 0, 0, 0))
base.paste(im, (pad, pad))

m = base.getchannel('A')
for _ in range(r):
    m = m.filter(ImageFilter.MaxFilter(3))
# Tira o degrau do quadrado do MaxFilter e devolve o antialias. O
# alisamento acompanha o raio: fixo em 1.1 ele comeria boa parte de um
# traco de 2px, que e da mesma ordem de grandeza.
suave = max(0.45, min(1.1, r * 0.36))
m = m.filter(ImageFilter.GaussianBlur(suave))
m = m.point(lambda v: 0 if v < 40 else 255 if v > 150 else int((v - 40) / 110 * 255))

traco = Image.new('RGBA', base.size, cor + (255,))
traco.putalpha(m)
out = Image.alpha_composite(traco, base)
out = out.crop(out.getchannel('A').getbbox())

cam = os.path.join(aqui, 'historias-de-atrito-traco.webp')
out.save(cam, 'WEBP', quality=92, method=6)
print(f'{out.size[0]}x{out.size[1]}  {os.path.getsize(cam)/1024:.0f} KB  (raio {r}px, #{cor_hex})')
