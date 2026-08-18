# Trilha — onde os arquivos entram

Solte aqui os cinco arquivos, com estes nomes:

| arquivo | disco | clima | estado |
|---|---|---|---|
| `01-sem-pressa.m4a`   | 01 Sem pressa   | devagar        | **faixa de demonstração** (ver abaixo) |
| `02-friccao.mp3`      | 02 Fricção      | quente         | falta |
| `03-madrugada.mp3`    | 03 Madrugada    | baixo e escuro | falta |
| `04-primeira-vez.mp3` | 04 Primeira vez | nervoso        | falta |
| `05-depois.mp3`       | 05 Depois       | calmo          | falta |

Não precisa mexer em código: os caminhos já estão no `DISCOS`, em `../common.js`. Ao abrir
a janela a página faz um `HEAD` em cada arquivo — o que não existe fica com o play
desabilitado, o que existe toca. Pode subir menos de cinco; os que faltarem ficam mudos.

Trocando a extensão (mp3, m4a, ogg), ajuste o caminho no `DISCOS`.

## A faixa de demonstração

`01-sem-pressa.m4a` **não é uma faixa comercial nem material de terceiro.** Foi sintetizada
por `compor-demo.py`, que está nesta pasta: pad de acordes em lá menor, baixo em pedal,
pulso surdo e um véu de ruído filtrado, com eco curto. 88 segundos, AAC 112 kbps.

Ela existe só para **demonstrar o mecanismo** ao cliente — escolher o disco, apertar o
play, ver o vinil girar e o som continuar com a janela fechada. Não é a trilha da
campanha e não deve ir para o ar como se fosse.

Para regerar ou mexer nos acordes:

```bash
python3 compor-demo.py                       # gera demo.wav
afconvert -f m4af -d aac -b 112000 demo.wav 01-sem-pressa.m4a
```

## Antes de subir a trilha de verdade

**A faixa precisa estar licenciada para uso comercial** — é página de marca, com o nome da
Prudence em cima. Faixa de banco (Epidemic Sound, Artlist, Uppbeat/Music Vine) resolve;
fonograma comercial baixado do YouTube, não.

Guarde o comprovante da licença junto do material da campanha.
