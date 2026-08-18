# Casos de atrito

Preview público da landing de campanha do **Prudence Lub**. Só os arquivos do site —
o repositório de trabalho, com histórico e documentação, é privado.

- `index.html` — hero, formulário de relato anônimo e feed
- `lub.html` — O Lub: produto, ficha técnica e onde comprar
- `assets/` — CSS, JS, marca e imagens
- `assets/audio/` — trilha; hoje só o disco 01, com faixa de demonstração

Estático, sem build e sem dependência externa.

## O que ainda é provisório

- **A trilha é demonstração.** `assets/audio/01-sem-pressa.m4a` foi sintetizado
  (`compor-demo.py`, na mesma pasta), não é faixa comercial nem material de terceiro, e
  serve só para mostrar o mecanismo. Os outros quatro discos estão mudos. A trilha
  definitiva depende de licença.
- **Nada é enviado nem armazenado.** Não existe backend: o formulário só mostra a
  confirmação, e o feed lê o `localStorage` do próprio navegador.
- **O contador de "anônimos online" é simulado.** Não há backend de presença.
- **A arte da hero** diz *histórias de atrito*, enquanto títulos e textos ainda dizem
  *Casos de atrito* — o nome da campanha não foi fechado.


> **Preview, não produção.** Marcado como `noindex` de propósito: o conteúdo ainda tem
> itens pendentes de validação do cliente. Não divulgar como página oficial.
