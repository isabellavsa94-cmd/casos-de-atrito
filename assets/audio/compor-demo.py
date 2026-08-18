"""Faixa de demonstracao da trilha — composta aqui, sem material de terceiro.
Pad lento em menor, baixo em pedal, pulso surdo tipo batimento e um veu de
ruido filtrado. Nada aqui e sample nem citacao: e sintese pura."""
import numpy as np, wave, struct, sys

SR = 44100
BPM = 62
COMP = 88.0                      # segundos
t = np.arange(int(SR*COMP))/SR

def nota(m):                     # midi -> Hz
    return 440.0*2**((m-69)/12)

# progressao lenta em la menor: Am9 - Fmaj7 - Cmaj7 - Em7, 8s cada
ACORDES = [[57,64,69,72,76],[53,60,65,69,72],[48,55,60,64,67],[52,59,64,67,71]]
DUR = 8.0

def env(n, sobe, desce):
    e = np.ones(n)
    a = int(SR*sobe); d = int(SR*desce)
    e[:a] = np.linspace(0,1,a)**1.6
    e[-d:] = np.linspace(1,0,d)**1.4
    return e

mix = np.zeros_like(t)

# --- pad: cada voz com leve desafinacao e vibrato preguicoso
for i in range(int(COMP/DUR)+1):
    ac = ACORDES[i % len(ACORDES)]
    ini = int(i*DUR*SR)
    n = min(int(DUR*1.5*SR), len(t)-ini)
    if n <= 0: break
    tt = np.arange(n)/SR
    voz = np.zeros(n)
    for k, m in enumerate(ac):
        f = nota(m)
        for det in (-0.09, 0.0, 0.11):
            vib = 1 + 0.0016*np.sin(2*np.pi*(0.21+0.03*k)*tt + k)
            ondas = (np.sin(2*np.pi*(f+det)*vib*tt)
                     + 0.32*np.sin(2*np.pi*2*(f+det)*vib*tt)
                     + 0.13*np.sin(2*np.pi*3*(f+det)*vib*tt))
            voz += ondas/(1.7+k*0.55)
    mix[ini:ini+n] += voz*env(n, 2.4, 3.0)*0.052

# --- baixo em pedal, uma oitava abaixo da fundamental
for i in range(int(COMP/DUR)+1):
    f = nota(ACORDES[i % len(ACORDES)][0]-12)
    ini = int(i*DUR*SR); n = min(int(DUR*SR), len(t)-ini)
    if n <= 0: break
    tt = np.arange(n)/SR
    mix[ini:ini+n] += (np.sin(2*np.pi*f*tt) + 0.2*np.sin(2*np.pi*2*f*tt))*env(n,1.2,1.6)*0.14

# --- pulso surdo: dois toques por compasso, como batimento
pulso = 60.0/BPM
i = 0.0
while i < COMP-1:
    for atraso, forca in ((0.0, 1.0), (0.30, 0.55)):
        ini = int((i+atraso)*SR); n = int(0.20*SR)
        if ini+n >= len(mix): break
        tt = np.arange(n)/SR
        f = 62*np.exp(-tt*13)
        mix[ini:ini+n] += np.sin(2*np.pi*f*tt)*np.exp(-tt*11)*0.30*forca
    i += pulso*2

# --- veu de ruido: passa-baixa por media movel, com respiracao lenta
r = np.random.default_rng(7).normal(0, 1, len(t))
k = 420
r = np.convolve(r, np.ones(k)/k, mode='same')
r /= (np.abs(r).max()+1e-9)
mix += r*(0.030 + 0.016*np.sin(2*np.pi*0.055*t))

# --- eco curto, pra dar sala
eco = int(0.34*SR)
d = np.zeros_like(mix); d[eco:] = mix[:-eco]*0.30
mix += d

# --- estereo: o eco abre pros lados
L = mix.copy(); R = np.zeros_like(mix)
off = int(0.013*SR); R[off:] = mix[:-off]
R += d*0.4; L += np.roll(d, off)*0.2

# --- abre e fecha, e normaliza com folga
fade = int(3.5*SR)
for c in (L, R):
    c[:fade] *= np.linspace(0,1,fade)**1.5
    c[-fade:] *= np.linspace(1,0,fade)**1.2
pico = max(np.abs(L).max(), np.abs(R).max())
L = np.tanh(L/pico*1.05)*0.89; R = np.tanh(R/pico*1.05)*0.89

inter = np.empty(len(L)*2); inter[0::2] = L; inter[1::2] = R
w = wave.open('demo.wav','w'); w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
w.writeframes(struct.pack('<%dh'%len(inter), *(inter*32000).astype(np.int16)))
w.close()
print('demo.wav: %.1fs' % COMP)
