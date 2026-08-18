/* =============================================================
   Lâmina d'água — equação de onda em WebGL2.

   A tela é uma superfície de água com campo de altura: o cursor
   pinga, a ondulação se propaga em anéis concêntricos, reflete
   nas bordas e interfere consigo mesma. A inclinação da
   superfície vira normal e refrata o fundo.

   Só se move com o ponteiro — parado é parado.
   ============================================================= */
(() => {
  const root = document.documentElement;
  const canvas = document.getElementById('fluid');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const gl = reduced ? null : canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance'
  });

  if (!gl || !(gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float'))) {
    root.classList.add('no-fluid');
    return;
  }

  const CFG = {
    SIM_RES: 620,          // grade da superfície — ondulação precisa de resolução
    SUBSTEPS: 3,           // passos de onda por frame (controla a propagação)
    C2: 0.45,              // velocidade² da onda — acima de 0.5 o esquema explode
    DAMPING: 0.9965,       // quanto a ondulação demora pra morrer
    DROP_RADIUS: 0.00022,  // raio da gaussiana do pingo
    DROP_SPACING: 0.006,   // distância entre pingos ao arrastar o cursor
    NORMAL_SCALE: 30.0,
    REFRACTION: 0.055
  };

  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };

  class Program {
    constructor(vs, fs) {
      this.p = gl.createProgram();
      gl.attachShader(this.p, vs);
      gl.attachShader(this.p, fs);
      gl.linkProgram(this.p);
      if (!gl.getProgramParameter(this.p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.p));
      this.u = {};
      const n = gl.getProgramParameter(this.p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(this.p, i).name;
        this.u[name] = gl.getUniformLocation(this.p, name);
      }
    }
    use() { gl.useProgram(this.p); }
  }

  const VERT = `#version 300 es
  precision highp float;
  layout(location = 0) in vec2 aPosition;
  out vec2 vUv, vL, vR, vT, vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }`;

  const HEAD = `#version 300 es
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv, vL, vR, vT, vB;
  out vec4 fragColor;`;

  const SH = {
    /* pingo: soma uma gaussiana na altura atual */
    drop: `${HEAD}
      uniform sampler2D uHeight;
      uniform vec2 point; uniform float radius; uniform float amount; uniform float aspectRatio;
      void main(){
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        float d = exp(-dot(p, p) / radius) * amount;
        vec2 h = texture(uHeight, vUv).xy;   // x = altura atual, y = altura anterior
        fragColor = vec4(h.x + d, h.y, 0.0, 1.0);
      }`,

    /* equação de onda: d²h/dt² = c² ∇²h, integrada por Verlet.
       CLAMP_TO_EDGE nas bordas faz a ondulação refletir na moldura da tela. */
    wave: `${HEAD}
      uniform sampler2D uHeight;
      uniform float c2; uniform float damping;
      void main(){
        vec2 h = texture(uHeight, vUv).xy;
        float l = texture(uHeight, vL).x;
        float r = texture(uHeight, vR).x;
        float t = texture(uHeight, vT).x;
        float b = texture(uHeight, vB).x;

        float lap = (l + r + t + b) - 4.0 * h.x;
        float nh = ((2.0 * h.x - h.y) + lap * c2) * damping;

        fragColor = vec4(nh, h.x, 0.0, 1.0);
      }`,

    /* composição: normal da superfície refrata o fundo + brilho na crista */
    display: `${HEAD}
      uniform sampler2D uHeight;
      uniform sampler2D uBackground;
      uniform float normalScale; uniform float refraction;

      void main(){
        float h = texture(uHeight, vUv).x;
        float l = texture(uHeight, vL).x;
        float r = texture(uHeight, vR).x;
        float t = texture(uHeight, vT).x;
        float b = texture(uHeight, vB).x;

        vec3 n = normalize(vec3(-(r - l) * normalScale, -(t - b) * normalScale, 1.0));

        // refração com dispersão cromática leve — é o que lê como água
        vec2 off = n.xy * refraction;
        vec3 bg;
        bg.r = texture(uBackground, vUv + off * 1.14).r;
        bg.g = texture(uBackground, vUv + off).g;
        bg.b = texture(uBackground, vUv + off * 0.86).b;

        vec3 lightDir = normalize(vec3(-0.42, 0.55, 0.72));
        float spec = pow(max(dot(n, lightDir), 0.0), 80.0);
        float fres = pow(1.0 - n.z, 2.2);

        vec3 col = bg;
        col += vec3(1.00, 1.00, 1.00) * spec * 0.55;          // crista da onda
        col -= vec3(0.30, 0.22, 0.10) * fres * 0.55;          // sombra navy no vale
        col += vec3(0.17, 0.31, 0.56) * max(h, 0.0) * 0.10;   // azul no volume

        fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }`
  };

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const P = {};
  for (const k in SH) P[k] = new Program(vs, compile(gl.FRAGMENT_SHADER, SH[k]));

  /* ---------- geometria fullscreen ---------- */
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, -1,1, 1,1, 1,-1]), gl.STATIC_DRAW);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0,1,2, 0,2,3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  const blit = (target) => {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  };

  /* ---------- framebuffers ---------- */
  function createFBO(w, h) {
    gl.activeTexture(gl.TEXTURE0);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, w, h, 0, gl.RG, gl.HALF_FLOAT, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      fbo, width: w, height: h,
      texelSizeX: 1 / w, texelSizeY: 1 / h,
      attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; }
    };
  }

  function createDouble(w, h) {
    let a = createFBO(w, h), b = createFBO(w, h);
    return {
      width: w, height: h, texelSizeX: a.texelSizeX, texelSizeY: a.texelSizeY,
      get read() { return a; }, get write() { return b; },
      swap() { const t = a; a = b; b = t; }
    };
  }

  let height, background;

  // grade com texels quadrados em tela — senão a ondulação sai elíptica
  function simSize() {
    const ar = gl.drawingBufferWidth / gl.drawingBufferHeight;
    const a = ar < 1 ? 1 / ar : ar;
    const min = Math.round(CFG.SIM_RES);
    const max = Math.round(CFG.SIM_RES * a);
    return ar > 1 ? { width: max, height: min } : { width: min, height: max };
  }

  function initFramebuffers() {
    const s = simSize();
    height = createDouble(s.width, s.height);
  }

  /* ---------- fundo procedural (a refração precisa de textura pra deslocar) ---------- */
  function buildBackground() {
    const W = 1000, H = 1000;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');

    x.fillStyle = '#f1f6f8';
    x.fillRect(0, 0, W, H);

    const blobs = [
      [0.20, 0.18, 0.66, 'rgba(195,215,222,0.95)'],
      [0.84, 0.26, 0.54, 'rgba(166,194,205,0.70)'],
      [0.52, 0.94, 0.72, 'rgba(44,78,143,0.30)'],
      [0.06, 0.74, 0.46, 'rgba(166,194,205,0.55)'],
      [0.72, 0.64, 0.40, 'rgba(27,49,96,0.16)'],
      [0.38, 0.44, 0.34, 'rgba(255,255,255,0.85)']
    ];
    for (const [px, py, rr, color] of blobs) {
      const g = x.createRadialGradient(px * W, py * H, 0, px * W, py * H, rr * W);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, W, H);
    }

    // grão fino — sem ele a refração não tem o que deslocar
    const img = x.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = (Math.random() - 0.5) * 14;
      d[i] += n; d[i + 1] += n; d[i + 2] += n;
    }
    x.putImageData(img, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
    background = { attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; } };
  }

  /* ---------- canvas sizing ---------- */
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.floor(canvas.clientWidth * dpr);
    const h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w; canvas.height = h;
    return true;
  }
  resize();
  buildBackground();
  initFramebuffers();

  /* ---------- pingos ---------- */
  const queue = [];
  const QUEUE_MAX = 48;

  function pushDrop(x, y, amount, radius) {
    if (queue.length >= QUEUE_MAX) return;
    queue.push([x, y, amount, radius || CFG.DROP_RADIUS]);
  }

  function flushDrops() {
    if (!queue.length) return;
    P.drop.use();
    gl.uniform1f(P.drop.u.aspectRatio, canvas.width / canvas.height);
    for (const [x, y, amount, radius] of queue) {
      gl.uniform1i(P.drop.u.uHeight, height.read.attach(0));
      gl.uniform2f(P.drop.u.point, x, y);
      gl.uniform1f(P.drop.u.radius, radius);
      gl.uniform1f(P.drop.u.amount, amount);
      blit(height.write);
      height.swap();
    }
    queue.length = 0;
  }

  /* ---------- entrada ---------- */
  function toUV(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return [(clientX - r.left) / r.width, 1 - (clientY - r.top) / r.height];
  }

  let lastX = null, lastY = null;

  window.addEventListener('pointermove', (e) => {
    const [x, y] = toUV(e.clientX, e.clientY);
    if (lastX === null) { lastX = x; lastY = y; return; }

    const dx = x - lastX, dy = y - lastY;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.0015) return;

    // pingos ao longo do trajeto: o cursor deixa um rastro contínuo de ondulação
    const steps = Math.min(Math.ceil(dist / CFG.DROP_SPACING), 14);
    const amount = 0.045 + Math.min(dist, 0.06) * 1.6;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      pushDrop(lastX + dx * t, lastY + dy * t, amount);
    }
    lastX = x; lastY = y;
    wake();
  }, { passive: true });

  // clique = pedra na água
  window.addEventListener('pointerdown', (e) => {
    const [x, y] = toUV(e.clientX, e.clientY);
    lastX = x; lastY = y;
    pushDrop(x, y, 0.75, CFG.DROP_RADIUS * 3.2);
    wake();
  }, { passive: true });

  /* ---------- passos ---------- */
  function stepWaves() {
    P.wave.use();
    gl.uniform2f(P.wave.u.texelSize, height.texelSizeX, height.texelSizeY);
    gl.uniform1f(P.wave.u.c2, CFG.C2);
    gl.uniform1f(P.wave.u.damping, CFG.DAMPING);
    for (let i = 0; i < CFG.SUBSTEPS; i++) {
      gl.uniform1i(P.wave.u.uHeight, height.read.attach(0));
      blit(height.write);
      height.swap();
    }
  }

  function render() {
    P.display.use();
    gl.uniform2f(P.display.u.texelSize, height.texelSizeX, height.texelSizeY);
    gl.uniform1f(P.display.u.normalScale, CFG.NORMAL_SCALE);
    gl.uniform1f(P.display.u.refraction, CFG.REFRACTION);
    gl.uniform1i(P.display.u.uHeight, height.read.attach(0));
    gl.uniform1i(P.display.u.uBackground, background.attach(1));
    blit(null);
  }

  /* ---------- loop sob demanda ----------
     A superfície só se move enquanto há interação. Depois do último pingo,
     roda até a ondulação assentar (SETTLE_MS) e então o loop PARA de vez —
     nada de rAF girando com a água parada. */
  const SETTLE_MS = 7000;   // com DAMPING=0.9965 a amplitude cai a ~1% nesse tempo
  let lastActivity = -Infinity;
  let looping = false;

  function wake() {
    lastActivity = performance.now();
    if (!looping) { looping = true; requestAnimationFrame(loop); }
  }

  function loop(now) {
    if (!looping) return;

    if (resize()) initFramebuffers();
    flushDrops();
    stepWaves();
    render();

    if (now - lastActivity > SETTLE_MS && !queue.length) { looping = false; return; }
    requestAnimationFrame(loop);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) looping = false;
  });

  // redimensionar com o loop parado ainda precisa repintar o fundo
  window.addEventListener('resize', () => {
    if (looping) return;
    if (resize()) initFramebuffers();
    render();
  }, { passive: true });

  // primeiro frame: água totalmente parada, só o fundo
  render();
})();



/* =============================================================
   Portao de 18+

   O portao ja vem no HTML e um script no <head> esconde ele antes
   de pintar pra quem ja confirmou — assim nao pisca nem o portao
   pra quem volta, nem o conteudo pra quem chega.

   Formalidade legal, nao seguranca: da pra burlar limpando o
   armazenamento. E o padrao do mercado pra conteudo adulto.
   ============================================================= */
(() => {
  const gate = document.getElementById('gate');
  if (!gate || document.documentElement.classList.contains('idade-ok')) return;

  const KEY = 'casos-de-atrito:idade';
  const ask = document.getElementById('gateAsk');
  const deny = document.getElementById('gateDeny');
  const yes = document.getElementById('gateYes');
  const no = document.getElementById('gateNo');

  const shape = document.getElementById('khShape');
  const box = gate.querySelector('.gate__box');
  const page = document.querySelector('.page');
  const semMovimento = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let animPagina = null;

  const finalizar = () => {
    document.documentElement.classList.add('idade-ok');
    gate.remove();
    if (page) {
      // Cancelar a animacao, nao so limpar o estilo: com fill:'forwards' ela
      // segue aplicando transform DEPOIS de terminar, e vence o inline. Mesmo
      // sendo identidade, qualquer transform != none (e o will-change) cria
      // bloco de contencao pra descendentes position:fixed — e a aba do rodape
      // e o contador passariam a se ancorar no fim do conteudo, nao na tela.
      if (animPagina) animPagina.cancel();
      page.style.transform = '';
      page.style.willChange = '';
    }
    // devolve o foco pro comeco da pagina, nao pro nada
    const first = document.querySelector('.nav__link');
    if (first) first.focus({ preventScroll: true });
  };

  /* Abre em fechadura: o furo aparece, respira e engole a tela.
     A escala 46 e o suficiente pro furo cobrir o viewBox de 100
     mesmo com preserveAspectRatio=slice em tela larga. */
  const abrirFechadura = async () => {
    gate.style.pointerEvents = 'none';        // ja entrou: nao intercepta mais clique

    box.animate([{ opacity: 1 }, { opacity: 0 }],
      { duration: 240, easing: 'ease-out', fill: 'forwards' });

    if (page) {
      page.style.willChange = 'transform';
      animPagina = page.animate([{ transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
        { duration: 1500, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'forwards' });
    }

    // 1. o furo aparece
    await shape.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }],
      { duration: 520, easing: 'cubic-bezier(.2,.9,.25,1)', fill: 'forwards' }).finished;

    // 2. respira um instante — e o momento do 'segredo'
    await new Promise(r => setTimeout(r, 260));

    // 3. engole a tela
    await shape.animate([{ transform: 'scale(1)' }, { transform: 'scale(46)' }],
      { duration: 950, easing: 'cubic-bezier(.66,0,.86,0)', fill: 'forwards' }).finished;

    finalizar();
  };

  const enter = () => {
    try { localStorage.setItem(KEY, 'ok'); } catch { /* modo privado */ }
    if (semMovimento || !shape || !shape.animate) { finalizar(); return; }
    abrirFechadura();
  };

  const block = () => {
    ask.hidden = true;
    deny.hidden = false;
    deny.querySelector('.gate__title').setAttribute('tabindex', '-1');
    deny.querySelector('.gate__title').focus();
  };

  yes.addEventListener('click', enter);
  no.addEventListener('click', block);

  // prende o foco: Tab nao pode sair do portao pro conteudo atras
  gate.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); return; }   // nao da pra fechar sem responder
    if (e.key !== 'Tab') return;

    const focusables = [...gate.querySelectorAll('button:not([hidden])')]
      .filter(el => el.offsetParent !== null);
    if (!focusables.length) return;

    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  yes.focus({ preventScroll: true });
})();

/* =============================================================
   Contador de "anonimos online"

   ATENCAO — este numero NAO e real.

   Nao existe backend de presenca, entao com PRESENCE_ENDPOINT vazio o
   valor e SIMULADO: um passeio aleatorio com piso em 32, conforme
   pedido. Nada aqui mede quem esta no site.

   Assim que existir presenca de verdade, preencha PRESENCE_ENDPOINT
   (GET devolvendo { online: <numero> }) e o numero passa a ser o do
   servidor — o piso deixa de ser aplicado.

   Exibir contagem inventada de usuarios online pode configurar
   publicidade enganosa (art. 37 do CDC). Decisao do cliente,
   registrada aqui e no README.
   ============================================================= */
(() => {
  const PRESENCE_ENDPOINT = '';   // GET -> { online: 123 }
  const PISO = 32;                // piso pedido: nunca comeca do zero
  const TETO = 96;

  const box = document.getElementById('live');
  const out = document.getElementById('liveN');
  if (!box || !out) return;

  const mostrar = (n) => { out.textContent = n; box.hidden = false; };

  if (PRESENCE_ENDPOINT) {
    const puxar = async () => {
      try {
        const res = await fetch(PRESENCE_ENDPOINT);
        if (!res.ok) throw new Error(res.status);
        const { online } = await res.json();
        if (Number.isFinite(online)) mostrar(online);   // numero real, sem piso
      } catch { /* sem presenca: nao inventa nada */ }
    };
    puxar();
    setInterval(puxar, 20000);
    return;
  }

  // ---- modo simulado ----
  // Passos de 1 (as vezes 2) imitam chegada e saida de uma pessoa por vez,
  // em vez de saltos. A reversao a media puxa de volta pro centro conforme
  // o valor se afasta, entao o numero respira em torno de ~44 sem grudar
  // no piso nem disparar pro teto.
  const CENTRO = PISO + 12;
  let n = PISO + Math.floor(Math.random() * 9);
  mostrar(n);

  const passo = () => {
    const tamanho = Math.random() < 0.78 ? 1 : 2;
    const pSobe = Math.min(0.86, Math.max(0.14, 0.5 + (CENTRO - n) * 0.022));
    const dir = Math.random() < pSobe ? 1 : -1;

    const anterior = n;
    n = Math.min(TETO, Math.max(PISO, n + dir * tamanho));
    if (n !== anterior) {
      mostrar(n);
      box.classList.remove('is-tick');
      void box.offsetWidth;           // reinicia a animacao
      box.classList.add('is-tick');
    }
    setTimeout(passo, 2500 + Math.random() * 3500);
  };
  setTimeout(passo, 1800 + Math.random() * 2200);
})();

/* ---------- reveal ---------- */
(() => {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  document.querySelectorAll('.r').forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i, 3) * 90}ms`;
    io.observe(el);
  });

})();

/* =============================================================
   Trilha — escolher o disco pra escrever "na vibe"

   Botao na ponta esquerda, fora do pill preto, abre a janela dos
   discos: um coverflow em WebGL2 com arrasto, inercia e encaixe.

   COMO ESTA MONTADO — duas camadas sobrepostas:

   1. DOM (semantica)  — um <button> por disco, com nome e clima no
      rotulo. E ele que responde a Tab, a leitor de tela e ao clique.
      As posicoes vem da MESMA conta que desenha o WebGL, entao a
      area de clique cai exatamente em cima do que se ve.
   2. WebGL (pixels)   — as capas viram textura e sao desenhadas num
      canvas so, com deformacao no arrasto, reflexo e fundo que troca
      de cor conforme o disco. Com o canvas no ar, as capas do DOM
      ficam transparentes: continuam clicaveis, so nao pintam.

   Sem WebGL2 (ou em prefers-reduced-motion) o canvas nao entra e as
   capas do DOM aparecem — mesmo layout, sem deformacao. Nada quebra.

   ATENCAO — as faixas ainda NAO tem audio.
   Todo `arquivo` esta vazio: o tocador esta inteiro (play/pause,
   tempo, barra, proxima/anterior, encadeamento no fim da faixa), mas
   sem arquivo ele fica desabilitado e a janela diz isso. Nada aqui
   simula reproducao: barra parada e "--:--" e o estado honesto de
   quem nao tem som.

   Pra ligar o som: coloque os arquivos em html/assets/audio/ e
   preencha `arquivo` de cada disco. Nada mais precisa mudar — e
   mesma origem, entao a pagina segue sem request externo.

   As capas sao PLACEHOLDER, desenhadas em canvas 2D a partir da
   paleta da campanha. Nao ha arte de marca inventada aqui: quando
   vier a arte real, cada disco troca o desenho por uma imagem.
   ============================================================= */
(() => {
  const DISCOS = [
    /* `capa` pinta o disco; `fundo` pinta a tela atras dele e faz a
       transicao de cor conforme se anda no carrossel. `tilt` e a
       inclinacao de repouso, em graus — some quando o disco assume o
       centro, entao so as vizinhas ficam tortas. */
    // 01 — faixa pedida: The Weeknd, "Earned It" (Fifty Shades of Grey).
    //      Fonograma comercial (Republic/XO): PRECISA de licenca de
    //      sincronizacao + fonograma antes de entrar. Nao baixar do
    //      YouTube. Com a licenca, e so apontar `arquivo` pro mp3.
    { n: '01', nome: 'Sem pressa',   vibe: 'devagar',        capa: '#c3d7de', fg: '#1b3160', fundo: '#25406f', tilt: -6.5, arquivo: 'assets/audio/01-sem-pressa.m4a' },
    { n: '02', nome: 'Fricção',      vibe: 'quente',         capa: '#2c4e8f', fg: '#f1f6f8', fundo: '#1d3568', tilt:  5.0, arquivo: 'assets/audio/02-friccao.mp3' },
    { n: '03', nome: 'Madrugada',    vibe: 'baixo e escuro', capa: '#16233f', fg: '#f1f6f8', fundo: '#0e1930', tilt: -8.0, arquivo: 'assets/audio/03-madrugada.mp3' },
    { n: '04', nome: 'Primeira vez', vibe: 'nervoso',        capa: '#a6c2cd', fg: '#16233f', fundo: '#2b4a80', tilt:  6.5, arquivo: 'assets/audio/04-primeira-vez.mp3' },
    { n: '05', nome: 'Depois',       vibe: 'calmo',          capa: '#1b3160', fg: '#f1f6f8', fundo: '#16294d', tilt: -4.5, arquivo: 'assets/audio/05-depois.mp3' },
  ];

  const ALBUM = 'Histórias de atrito, Vol. I';
  const CHAVE = 'casos-de-atrito:disco';

  /* Geometria do palco — medida na referencia a 1280x800:
     capa de 499px (39% da largura), vizinha em 0.545 da capa e a
     413px do centro. Uma queda de perspectiva 1/(1+a|d|) com a=0.83
     da os dois numeros de uma vez, e ainda comprime as de tras. */
  const PERSP    = 0.83;
  const VAO      = 1.54;   // passo lateral, em larguras de capa
  const CENTRO_Y = 0.56;   // altura do eixo das capas, em fracao da janela
  const SOBRA    = 0.09;   // quanto o pill do tocador cobre da capa
  const VEU      = 0.45;   // opacidade do fundo da janela: 1 tampa a pagina, 0 some

  const btn    = document.getElementById('trilhaBtn');
  const janela = document.getElementById('trilha');
  if (!btn || !janela) return;

  const palco  = document.getElementById('trilhaPalco');
  const nota   = document.getElementById('trilhaNota');
  const tocador= document.getElementById('tocador');
  const play   = document.getElementById('tocaPlay');
  const icoP   = document.getElementById('tocaIcoPlay');
  const icoS   = document.getElementById('tocaIcoPause');
  const elNome = document.getElementById('tocaNome');
  const elSub  = document.getElementById('tocaSub');
  const elTemp = document.getElementById('tocaTempo');
  const barra  = document.getElementById('tocaBarra');
  const fechar = document.getElementById('trilhaClose');

  const som = new Audio();
  som.preload = 'none';

  const reduzido = matchMedia('(prefers-reduced-motion:reduce)').matches;

  let atual = 0;              // disco escolhido (inteiro)
  let pos = 0;                // posicao no carrossel (fracionaria)
  let alvo = 0;               // pra onde ela esta indo
  let vel = 0;                // velocidade, em discos por frame
  let arrastando = false;
  let devolverFoco = null;
  let sumindo = null;
  let rodando = false;
  let capaPx = 320;           // lado da capa em pixels, recalculado no resize

  try {
    const salvo = parseInt(localStorage.getItem(CHAVE), 10);
    if (Number.isInteger(salvo) && DISCOS[salvo]) atual = salvo;
  } catch (e) { /* storage bloqueado: comeca no primeiro */ }
  pos = alvo = atual;

  const hex2rgb = (h) => [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];

  /* ---------- capas: desenhadas em canvas 2D ----------
     Mesmo desenho da versao em DOM — cor chapada, brilho na diagonal,
     numero em serifada, nome e clima. Vira textura no WebGL e imagem
     de fundo na versao sem WebGL. */
  const TEX = 512;
  const SANS  = getComputedStyle(document.body).fontFamily || 'Helvetica, Arial, sans-serif';
  const SERIF = getComputedStyle(document.documentElement)
    .getPropertyValue('--serif').trim() || 'Georgia, serif';

  function desenharCapa(d) {
    const c = document.createElement('canvas');
    c.width = c.height = TEX;
    const x = c.getContext('2d');

    x.fillStyle = d.capa;
    x.fillRect(0, 0, TEX, TEX);

    // sombreado do papel: claro no alto, fundo no pe
    let g = x.createLinearGradient(0, 0, TEX * 0.55, TEX);
    g.addColorStop(0, 'rgba(255,255,255,.17)');
    g.addColorStop(1, 'rgba(0,0,0,.25)');
    x.fillStyle = g; x.fillRect(0, 0, TEX, TEX);

    // brilho do plastico, na diagonal
    g = x.createLinearGradient(TEX * 0.15, 0, TEX * 0.92, TEX);
    g.addColorStop(0.36, 'rgba(255,255,255,0)');
    g.addColorStop(0.47, 'rgba(255,255,255,.13)');
    g.addColorStop(0.58, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, TEX, TEX);

    const pad = TEX * 0.075;
    x.fillStyle = d.fg;
    x.textBaseline = 'alphabetic';

    x.globalAlpha = 0.72;
    x.font = `700 ${TEX * 0.026}px ${SANS}`;
    x.letterSpacing = `${TEX * 0.005}px`;
    x.fillText('PRUDENCE LUB', pad, pad + TEX * 0.026);
    x.letterSpacing = '0px';

    // o pe da capa fica livre: e onde o pill do tocador encosta
    const base = TEX * 0.80;
    x.globalAlpha = 0.42;
    x.font = `400 ${TEX * 0.135}px ${SERIF}`;
    x.fillText(d.n, pad, base - TEX * 0.135);

    x.globalAlpha = 1;
    x.font = `400 ${TEX * 0.072}px ${SERIF}`;
    x.fillText(d.nome, pad, base - TEX * 0.03);

    x.globalAlpha = 0.66;
    x.font = `400 ${TEX * 0.028}px ${SANS}`;
    x.letterSpacing = `${TEX * 0.004}px`;
    x.fillText(d.vibe.toUpperCase(), pad, base + TEX * 0.012);

    // grao fino, pro chapado nao ficar plastico demais
    x.globalAlpha = 1;
    const img = x.getImageData(0, 0, TEX, TEX);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 9;
      img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
    }
    x.putImageData(img, 0, 0);

    return c;
  }

  const artes = DISCOS.map(desenharCapa);

  /* ---------- capas no DOM: semantica, foco e clique ---------- */
  const capas = DISCOS.map((d, i) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'capa';
    el.addEventListener('click', () => {
      if (moveu) return;                       // arrasto nao conta como clique
      i === atual ? alternar() : irPara(i);
    });
    palco.appendChild(el);
    return el;
  });

  /* ---------- WebGL: as capas de verdade ---------- */
  const gl = (() => {
    if (reduzido) return null;
    const c = document.createElement('canvas');
    c.className = 'trilha__gl';
    c.setAttribute('aria-hidden', 'true');
    // alpha no contexto: o palco nao pinta uma parede opaca, ele
    // deita um veu por cima da lamina d'agua da pagina
    const ctx = c.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!ctx) return null;
    janela.insertBefore(c, palco);
    return ctx;
  })();

  let R = null;   // renderizador; null = versao sem WebGL
  if (gl) {
    janela.classList.add('tem-gl');
    R = montarGL(gl, artes);
  } else {
    // sem WebGL as capas do DOM e que pintam
    capas.forEach((el, i) => { el.style.backgroundImage = `url(${artes[i].toDataURL('image/png')})`; });
  }

  /* ---------- layout: uma conta so pro DOM e pro WebGL ----------
     Cada disco vira {x, escala, giro, alpha} a partir da distancia
     ate a posicao atual. A queda 1/(1+a|d|) e o que da a perspectiva:
     a vizinha cai pra 0.55 e as de tras se comprimem. */
  function lugar(i) {
    const d = i - pos;
    const q = 1 / (1 + Math.abs(d) * PERSP);
    const grau = DISCOS[i].tilt * Math.min(1, Math.abs(d));
    return {
      d,
      x: d * q * VAO * capaPx,
      escala: q,
      giro: grau * Math.PI / 180,
      // capa e papel, nao vidro: opaca ate a beirada, some so ao sair de cena
      alpha: Math.max(0, Math.min(1, (2.7 - Math.abs(d)) / 0.7)),
    };
  }

  function medir() {
    const r = janela.getBoundingClientRect();
    // em tela larga a capa ocupa 39% (medida da referencia); em tela
    // estreita nao cabe vizinha nenhuma de qualquer jeito, entao ela
    // cresce e o disco do meio e que manda
    capaPx = Math.min(r.width * (r.width < 720 ? 0.74 : 0.39), r.height * 0.5);
    const cy = r.height * CENTRO_Y;
    palco.style.setProperty('--cy', `${cy}px`);
    palco.style.setProperty('--capa-w', `${capaPx}px`);

    // o tocador encosta no pe da capa e acompanha a largura dela.
    // `top` e o centro do pill (ele mesmo se puxa metade pra cima),
    // entao a borda de cima e que precisa cair dentro da capa.
    tocador.style.width =
      `${Math.round(Math.min(Math.max(capaPx * 0.76, 250), r.width - 28))}px`;
    const alturaPill = tocador.offsetHeight || 68;
    tocador.style.top =
      `${Math.round(cy + capaPx / 2 - capaPx * SOBRA + alturaPill / 2)}px`;

    if (R) R.medir(r.width, r.height, cy);
  }

  function posicionar() {
    capas.forEach((el, i) => {
      const p = lugar(i);
      el.hidden = Math.abs(p.d) > 2.6;
      el.style.transform =
        `translate(-50%,-50%) translateX(${p.x}px) rotate(${p.giro}rad) scale(${p.escala})`;
      el.style.zIndex = String(20 - Math.round(Math.abs(p.d) * 10));
      if (!R) el.style.opacity = p.alpha;      // com WebGL a capa do DOM nao pinta nada
      const d = DISCOS[i];
      el.setAttribute('aria-label',
        `${d.n}. ${d.nome} — ${d.vibe}${i === atual ? ' (selecionado)' : ''}`);
      el.setAttribute('aria-current', i === atual ? 'true' : 'false');
    });
  }

  /* ---------- fisica: arrasto, inercia e encaixe ---------- */
  const limite = (v) => Math.max(0, Math.min(DISCOS.length - 1, v));

  function passo() {
    if (reduzido) { pos = alvo; vel = 0; }     // sem animacao: troca seca
    else if (!arrastando) {
      // mola amortecida ate o disco mais proximo
      const f = (alvo - pos) * 0.14;
      vel = (vel + f) * 0.76;
      pos += vel;
      if (Math.abs(alvo - pos) < 0.0008 && Math.abs(vel) < 0.0008) { pos = alvo; vel = 0; }
    }

    const quieto = !arrastando && vel === 0 && pos === alvo;
    posicionar();
    if (R) R.desenhar(pos, vel, arrastando);

    // o pill some enquanto o carrossel anda e volta quando assenta
    tocador.classList.toggle('is-oculto', arrastando || Math.abs(vel) > 0.006);

    const perto = Math.round(pos);
    if (perto !== atual && Math.abs(perto - pos) < 0.5) trocarDisco(perto);

    if (quieto) { rodando = false; return; }
    requestAnimationFrame(passo);
  }

  function acordar() {
    if (rodando) return;
    rodando = true;
    requestAnimationFrame(passo);
  }

  function irPara(i, tocar) {
    alvo = limite(i);
    acordar();
    if (tocar !== undefined) trocarDisco(alvo, tocar);
  }

  /* ---------- arrasto ---------- */
  let x0 = 0, pos0 = 0, ultX = 0, ultT = 0, velPx = 0, moveu = false, ponteiro = null;

  let pendente = false;

  /* A captura de ponteiro so entra DEPOIS que o dedo anda de verdade.
     Capturar ja no pointerdown redireciona o clique pro palco, e ai
     clicar numa capa vizinha virava clique no fundo — que fecha a
     janela em vez de trocar de disco. */
  palco.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    pendente = true; moveu = false; ponteiro = e.pointerId;
    x0 = ultX = e.clientX; pos0 = pos; velPx = 0; ultT = performance.now();
  });

  palco.addEventListener('pointermove', (e) => {
    if ((!pendente && !arrastando) || e.pointerId !== ponteiro) return;
    const dx = e.clientX - x0;

    if (pendente) {
      if (Math.abs(dx) <= 4) return;          // ainda pode ser clique
      pendente = false; arrastando = true; moveu = true;
      palco.setPointerCapture(e.pointerId);
      palco.classList.add('is-arrastando');
      acordar();
    }

    const agora = performance.now();
    const dt = Math.max(1, agora - ultT);
    velPx = (e.clientX - ultX) / dt * 16;      // px por frame
    ultX = e.clientX; ultT = agora;

    let p = pos0 - dx / (VAO * capaPx);
    // fora das pontas o arrasto fica pesado, em vez de travar seco
    if (p < 0) p = p * 0.32;
    else if (p > DISCOS.length - 1) p = (DISCOS.length - 1) + (p - (DISCOS.length - 1)) * 0.32;
    pos = p;
    vel = -velPx / (VAO * capaPx);
  });

  const soltar = (e) => {
    if (e && e.pointerId !== ponteiro) return;
    pendente = false;
    if (!arrastando) { ponteiro = null; return; }   // foi clique, nao arrasto
    arrastando = false; ponteiro = null;
    palco.classList.remove('is-arrastando');
    // a inercia decide quantos discos ainda passam
    alvo = limite(Math.round(pos + vel * 9));
    acordar();
    setTimeout(() => { moveu = false; }, 0);
  };
  palco.addEventListener('pointerup', soltar);
  palco.addEventListener('pointercancel', soltar);

  // roda do mouse / trackpad: o eixo que se mexer mais manda
  let travaRoda = 0;
  palco.addEventListener('wheel', (e) => {
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(dx) < 2) return;
    e.preventDefault();
    const agora = performance.now();
    if (agora - travaRoda < 260) return;
    travaRoda = agora;
    irPara(alvo + Math.sign(dx));
  }, { passive: false });

  /* ---------- tocador ---------- */
  const mmss = (s) =>
    Number.isFinite(s)
      ? `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
      : '--:--';

  /* Os caminhos ja apontam pra assets/audio/. O que ainda nao existe
     entra em `semArquivo` na primeira abertura, e o disco fica com o
     play desabilitado — nada de botao que promete som e nao entrega.
     Soltar o mp3 na pasta com o nome certo e o unico passo que falta. */
  const semArquivo = new Set();
  let sondado = false;

  const temAudio = (i) => !!DISCOS[i].arquivo && !semArquivo.has(i);

  async function sondar() {
    if (sondado) return;
    sondado = true;
    await Promise.all(DISCOS.map(async (d, i) => {
      if (!d.arquivo) { semArquivo.add(i); return; }
      try {
        const r = await fetch(d.arquivo, { method: 'HEAD' });
        if (!r.ok) semArquivo.add(i);
      } catch (e) { semArquivo.add(i); }
    }));
    pintarTocador();
    pintarEstado();
  }

  const pintarTocador = () => {
    const d = DISCOS[atual];
    elNome.textContent = `${d.n}. ${d.nome}`;
    elSub.textContent = ALBUM;
    play.disabled = !temAudio(atual);
    nota.hidden = temAudio(atual);
    if (!temAudio(atual)) { elTemp.textContent = '--:--'; barra.style.width = '0%'; }
  };

  const pintarEstado = () => {
    const tocando = !som.paused && temAudio(atual);
    icoP.hidden = tocando;
    icoS.hidden = !tocando;
    play.setAttribute('aria-label', tocando ? 'Pausar' : 'Tocar');
    btn.classList.toggle('is-tocando', tocando);
    janela.classList.toggle('is-tocando', tocando);
  };

  function trocarDisco(i, tocar) {
    if (i === atual && tocar === undefined) return;
    atual = limite(i);
    try { localStorage.setItem(CHAVE, String(atual)); } catch (e) { /* segue sem lembrar */ }

    const tocava = tocar !== undefined ? tocar : !som.paused;
    som.pause();
    if (temAudio(atual)) {
      som.src = DISCOS[atual].arquivo;
      if (tocava) som.play().catch(() => { /* o navegador pode barrar */ });
    } else {
      som.removeAttribute('src');
    }
    pintarTocador();
    pintarEstado();
  }

  const alternar = () => {
    if (!temAudio(atual)) return;
    if (!som.src) som.src = DISCOS[atual].arquivo;
    if (som.paused) som.play().catch(() => {}); else som.pause();
  };

  play.addEventListener('click', alternar);
  document.getElementById('tocaPrev').addEventListener('click', () => irPara(alvo - 1));
  document.getElementById('tocaNext').addEventListener('click', () => irPara(alvo + 1));

  som.addEventListener('error', () => {
    const i = DISCOS.findIndex(d => som.src.endsWith(d.arquivo));
    if (i >= 0) semArquivo.add(i);
    pintarTocador(); pintarEstado();
  });
  som.addEventListener('play', pintarEstado);
  som.addEventListener('pause', pintarEstado);
  som.addEventListener('ended', () => irPara(atual + 1, true));
  som.addEventListener('timeupdate', () => {
    elTemp.textContent = `${mmss(som.currentTime)} / ${mmss(som.duration)}`;
    barra.style.width = som.duration ? `${(som.currentTime / som.duration) * 100}%` : '0%';
  });
  som.addEventListener('loadedmetadata', () => {
    elTemp.textContent = `${mmss(som.currentTime)} / ${mmss(som.duration)}`;
  });

  /* ---------- abrir e fechar ---------- */
  const focaveis = () =>
    [...janela.querySelectorAll('button:not([hidden]):not(:disabled)')]
      .filter(el => el.offsetParent !== null);

  const abrir = () => {
    clearTimeout(sumindo);
    devolverFoco = document.activeElement;
    janela.hidden = false;
    document.documentElement.classList.add('trilha-aberta');
    btn.setAttribute('aria-expanded', 'true');
    sondar();
    medir();
    pos = alvo = atual; vel = 0;
    void janela.offsetWidth;
    janela.classList.add('is-aberta');
    acordar();
    capas[atual].focus({ preventScroll: true });
  };

  const sair = () => {
    janela.classList.remove('is-aberta');
    btn.setAttribute('aria-expanded', 'false');
    document.documentElement.classList.remove('trilha-aberta');
    // a musica NAO para junto: a ideia e escrever com ela tocando
    clearTimeout(sumindo);
    const some = () => { janela.hidden = true; };
    if (reduzido) some(); else sumindo = setTimeout(some, 400);
    if (devolverFoco && devolverFoco.focus) devolverFoco.focus({ preventScroll: true });
  };

  btn.addEventListener('click', abrir);
  fechar.addEventListener('click', sair);
  // o palco cobre a janela inteira, entao "clicar fora" e clicar nele
  // mesmo, longe das capas — e nunca no fim de um arrasto
  palco.addEventListener('click', (e) => { if (e.target === palco && !moveu) sair(); });

  janela.addEventListener('keydown', (e) => {
    if (e.key === 'Escape')     { e.preventDefault(); sair(); return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); irPara(alvo - 1); capas[limite(alvo)].focus(); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); irPara(alvo + 1); capas[limite(alvo)].focus(); return; }
    if (e.key !== 'Tab') return;

    const lista = focaveis();
    if (!lista.length) return;
    const primeiro = lista[0], ultimo = lista[lista.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
  });

  addEventListener('resize', () => { if (!janela.hidden) { medir(); acordar(); } });

  medir();
  posicionar();
  pintarTocador();
  pintarEstado();

  /* =============================================================
     Renderizador WebGL

     Cada capa e uma malha 24x24 desenhada com deformacao: no arrasto
     o topo e a base saem em sentidos opostos (cisalha) e o meio
     atrasa (barriga), que e o que da a sensacao de pano em vez de
     figurinha deslizando. Abaixo de cada capa vai o reflexo, com a
     textura invertida e alpha caindo. O fundo e um quad de tela
     inteira cuja cor interpola entre o disco de tras e o da frente.
     ============================================================= */
  function montarGL(gl, artes) {
    const compilar = (tipo, src) => {
      const s = gl.createShader(tipo);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const programa = (v, f) => {
      const p = gl.createProgram();
      gl.attachShader(p, compilar(gl.VERTEX_SHADER, v));
      gl.attachShader(p, compilar(gl.FRAGMENT_SHADER, f));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const nome = gl.getActiveUniform(p, i).name;
        u[nome] = gl.getUniformLocation(p, nome);
      }
      return { p, u };
    };

    const CAPA_VS = `#version 300 es
      precision highp float;
      layout(location=0) in vec2 aG;      // -0.5..0.5
      uniform vec2  uRes;
      uniform vec2  uCentro;              // px, canto superior esquerdo
      uniform float uLado;                // px
      uniform float uGiro;
      uniform float uCisalha;             // px — topo e base em sentidos opostos
      uniform float uBarriga;             // px — o meio atrasa
      uniform float uRefl;
      out vec2 vUv;
      const float PI = 3.14159265;
      void main(){
        vUv = aG + 0.5;
        vec2 p = aG * uLado;
        p.x += uCisalha * aG.y * 2.0;
        p.x += uBarriga * cos(aG.y * PI);
        p.y += uBarriga * 0.18 * cos(aG.x * PI);
        float c = cos(uGiro), s = sin(uGiro);
        p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);
        if (uRefl > 0.5) p.y = -p.y;
        vec2 px = uCentro + p;
        vec2 ndc = px / uRes * 2.0 - 1.0;
        gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
      }`;

    const CAPA_FS = `#version 300 es
      precision highp float;
      in vec2 vUv;
      uniform sampler2D uTex;
      uniform float uAlpha, uRefl, uSombra;
      out vec4 cor;
      void main(){
        // o reflexo ja vem espelhado na geometria: inverter o uv aqui
        // de novo desfaria o espelho e colaria o topo da capa no pe dela
        vec4 c = texture(uTex, vUv);
        float a = uAlpha;
        // o reflexo morre rapido: so a lambida logo abaixo da capa
        if (uRefl > 0.5) a *= 0.17 * pow(clamp(vUv.y, 0.0, 1.0), 5.0);
        c.rgb *= uSombra;
        cor = vec4(c.rgb * a, a);
      }`;

    const FUNDO_VS = `#version 300 es
      precision highp float;
      layout(location=0) in vec2 aG;
      void main(){ gl_Position = vec4(aG * 2.0, 0.0, 1.0); }`;

    const FUNDO_FS = `#version 300 es
      precision highp float;
      uniform vec2 uRes;
      uniform vec3 uA, uB;
      uniform float uMix, uCy, uVeu;
      out vec4 cor;
      float ruido(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        vec2 uv = gl_FragCoord.xy / uRes;
        vec3 base = mix(uA, uB, uMix);
        // clarao atras das capas, no eixo delas
        float ar = uRes.x / uRes.y;
        float d = distance(vec2(uv.x * ar, uv.y), vec2(0.5 * ar, 1.0 - uCy));
        vec3 c = mix(base * 1.30, base * 0.86, smoothstep(0.05, 0.85, d));
        c += (ruido(gl_FragCoord.xy) - 0.5) * 0.022;
        // pre-multiplicado: o veu escurece e tinge, mas deixa passar
        cor = vec4(c * uVeu, uVeu);
      }`;

    const capaP  = programa(CAPA_VS, CAPA_FS);
    const fundoP = programa(FUNDO_VS, FUNDO_FS);

    // malha 24x24: resolucao suficiente pra deformacao nao facetar
    const N = 24, verts = [], idx = [];
    for (let y = 0; y <= N; y++)
      for (let x = 0; x <= N; x++) verts.push(x / N - 0.5, y / N - 0.5);
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const a = y * (N + 1) + x, b = a + 1, c = a + N + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);

    const quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-.5,-.5, .5,-.5, -.5,.5, .5,.5]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texturas = artes.map((c) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    });

    const fundos = DISCOS.map(d => hex2rgb(d.fundo));
    const cv = gl.canvas;
    let W = 0, H = 0, CY = 0, dpr = 1;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // textura ja sai pre-multiplicada

    return {
      medir(w, h, cy) {
        dpr = Math.min(devicePixelRatio || 1, 2);
        W = w; H = h; CY = cy;
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${h}px`;
      },

      desenhar(pos, vel, arrastando) {
        gl.viewport(0, 0, cv.width, cv.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // ---- fundo: cor do disco de tras interpolando com a do da frente
        const i0 = Math.max(0, Math.min(DISCOS.length - 1, Math.floor(pos)));
        const i1 = Math.max(0, Math.min(DISCOS.length - 1, i0 + 1));
        gl.useProgram(fundoP.p);
        gl.bindVertexArray(quadVao);
        gl.uniform2f(fundoP.u.uRes, cv.width, cv.height);
        gl.uniform3fv(fundoP.u.uA, fundos[i0]);
        gl.uniform3fv(fundoP.u.uB, fundos[i1]);
        gl.uniform1f(fundoP.u.uMix, Math.max(0, Math.min(1, pos - i0)));
        gl.uniform1f(fundoP.u.uCy, CY / H);
        gl.uniform1f(fundoP.u.uVeu, VEU);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // ---- capas: de tras pra frente, pra a do centro ficar por cima
        gl.useProgram(capaP.p);
        gl.bindVertexArray(vao);
        gl.uniform2f(capaP.u.uRes, cv.width, cv.height);

        // quanto o carrossel esta andando, em px por frame
        const andar = vel * VAO * capaPx;
        const ordem = DISCOS.map((_, i) => i)
          .filter(i => Math.abs(i - pos) < 2.8)
          .sort((a, b) => Math.abs(b - pos) - Math.abs(a - pos));

        for (const passe of [1, 0]) {          // 1 = reflexo, depois a capa
          for (const i of ordem) {
            const L = lugar(i);
            const lado = capaPx * L.escala * dpr;
            const cx = (W / 2 + L.x) * dpr;
            const cy = (CY + (passe ? capaPx * L.escala : 0)) * dpr;

            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, texturas[i]);
            gl.uniform1i(capaP.u.uTex, 0);
            gl.uniform2f(capaP.u.uCentro, cx, cy);
            gl.uniform1f(capaP.u.uLado, lado);
            gl.uniform1f(capaP.u.uGiro, L.giro);
            gl.uniform1f(capaP.u.uCisalha, -andar * 0.30 * dpr * L.escala);
            gl.uniform1f(capaP.u.uBarriga, -andar * 0.55 * dpr * L.escala);
            gl.uniform1f(capaP.u.uRefl, passe);
            gl.uniform1f(capaP.u.uAlpha, L.alpha);
            gl.uniform1f(capaP.u.uSombra, 1 - Math.min(0.34, Math.abs(L.d) * 0.16));
            gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
          }
        }
      },
    };
  }
})();

/* =============================================================
   Gotas na hero

   O lettering parece feito de agua, entao de vez em quando uma gota
   se forma numa ponta de baixo e cai.

   As pontas nao foram chutadas: sairam do perfil inferior da propria
   arte — pra cada coluna, o pixel opaco mais baixo; as pontas sao os
   minimos locais desse perfil, filtrados por espessura (gota nao se
   forma em fiapo) e espalhados pra nao cairem duas coladas. A cor de
   cada uma foi amostrada da arte logo acima do ponto, entao a gota
   sai da mesma agua da letra.

   Cadencia baixa de proposito: uma gota por vez, com intervalo de
   3 a 9 segundos. E um detalhe que se nota no canto do olho, nao um
   chafariz. Sem gota nenhuma em prefers-reduced-motion, e o relogio
   para com a aba oculta.
   ============================================================= */
(() => {
  const alvo = document.getElementById('heroGotas');
  if (!alvo || matchMedia('(prefers-reduced-motion:reduce)').matches) return;

  // x, y em % da arte; cor amostrada da propria imagem
  const PONTAS = [
    { x: 8.33,  y: 91.59, cor: '#badbde' },
    { x: 27.55, y: 97.26, cor: '#96c2c8' },
    { x: 42.02, y: 99.61, cor: '#96c2ca' },
    { x: 60.06, y: 89.43, cor: '#94c4cd' },
    { x: 69.57, y: 94.91, cor: '#96c2ca' },
    { x: 86.82, y: 90.41, cor: '#97c3cd' },
  ];

  const MIN = 3000, VAR = 6000;
  let relogio = null;
  let ultima = -1;

  const pingar = () => {
    // nao repete a mesma ponta em seguida: duas seguidas no mesmo
    // lugar leem como animacao em loop, nao como acaso
    let i = Math.floor(Math.random() * PONTAS.length);
    if (i === ultima) i = (i + 1 + Math.floor(Math.random() * (PONTAS.length - 1))) % PONTAS.length;
    ultima = i;
    const p = PONTAS[i];

    const g = document.createElement('span');
    g.className = 'gota';
    g.style.left = `${p.x}%`;
    g.style.top = `${p.y}%`;
    g.style.setProperty('--c', p.cor);
    g.style.setProperty('--d', `${(0.8 + Math.random() * 0.5).toFixed(2)}%`);
    g.style.setProperty('--queda', `${700 + Math.floor(Math.random() * 500)}%`);
    g.style.setProperty('--t', `${1700 + Math.floor(Math.random() * 900)}ms`);

    g.addEventListener('animationend', () => g.remove());
    alvo.appendChild(g);

    agendar();
  };

  const agendar = () => {
    clearTimeout(relogio);
    relogio = setTimeout(pingar, MIN + Math.random() * VAR);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(relogio); else agendar();
  });

  agendar();
})();
