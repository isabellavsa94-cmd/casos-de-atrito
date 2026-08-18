"""Gera a versao com contorno preto do lettering da hero.

O traco NAO e CSS: a arte e raster com alpha, entao o contorno sai de
uma dilatacao da propria silhueta. MaxFilter(3) cresce 1px por passe,
entao a largura fica exata e previsivel — nada de adivinhar limiar de
borrao, que foi a primeira tentativa e saiu com cara de brilho, nao de
contorno.

    python3 traco-hero.py 8      # raio em px, na escala do arquivo (1005px)

Saida: historias-de-atrito-traco.webp, ao lado deste script.
"""
import sys, os
from PIL import Image, ImageFilter

r = int(sys.argv[1]) if len(sys.argv) > 1 else 8
aqui = os.path.dirname(os.path.abspath(__file__))
im = Image.open(os.path.join(aqui, 'historias-de-atrito.webp')).convert('RGBA')

# folga: a arte esta rente ao bbox e o traco seria ceifado nas bordas
pad = r + 6
base = Image.new('RGBA', (im.width + pad*2, im.height + pad*2), (0, 0, 0, 0))
base.paste(im, (pad, pad))

m = base.getchannel('A')
for _ in range(r):
    m = m.filter(ImageFilter.MaxFilter(3))
# tira o degrau do quadrado do filtro e devolve o antialias
m = m.filter(ImageFilter.GaussianBlur(1.1))
m = m.point(lambda v: 0 if v < 40 else 255 if v > 150 else int((v - 40) / 110 * 255))

traco = Image.new('RGBA', base.size, (0, 0, 0, 255))
traco.putalpha(m)
out = Image.alpha_composite(traco, base)
out = out.crop(out.getchannel('A').getbbox())

cam = os.path.join(aqui, 'historias-de-atrito-traco.webp')
out.save(cam, 'WEBP', quality=92, method=6)
print(f'{out.size[0]}x{out.size[1]}  {os.path.getsize(cam)/1024:.0f} KB  (raio {r}px)')
