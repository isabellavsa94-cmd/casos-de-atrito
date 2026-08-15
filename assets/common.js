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

  const finalizar = () => {
    document.documentElement.classList.add('idade-ok');
    gate.remove();
    if (page) page.style.transform = '';
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
      page.animate([{ transform: 'scale(1.05)' }, { transform: 'scale(1)' }],
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
