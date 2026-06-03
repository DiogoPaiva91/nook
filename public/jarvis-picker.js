(function () {
  if (window.__jarvisPickerLoaded) return;
  window.__jarvisPickerLoaded = true;

  let active = false;
  let overlayEl = null;
  let labelEl = null;
  let lastTarget = null;
  let currentTarget = null; // elemento atualmente destacado (pode ser navegado pra cima/baixo)
  let baseTarget = null;    // elemento sob o cursor (base pra voltar com seta pra baixo)

  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement("div");
    overlayEl.id = "__jarvis_picker_overlay";
    overlayEl.style.cssText = "position:fixed;pointer-events:none;border:2px solid #ec4899;background:rgba(236,72,153,0.12);box-sizing:border-box;z-index:2147483646;border-radius:3px;display:none;transition:all 60ms ease-out";
    labelEl = document.createElement("div");
    labelEl.id = "__jarvis_picker_label";
    labelEl.style.cssText = "position:fixed;background:#ec4899;color:white;padding:2px 6px;font:600 11px ui-monospace,monospace;border-radius:3px;z-index:2147483647;display:none;pointer-events:none;white-space:nowrap";
    document.body.appendChild(overlayEl);
    document.body.appendChild(labelEl);
  }

  function setHighlight(el) {
    ensureOverlay();
    if (!el || el === document.body || el === document.documentElement) {
      overlayEl.style.display = "none";
      labelEl.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    overlayEl.style.display = "block";
    overlayEl.style.left = r.left + "px";
    overlayEl.style.top = r.top + "px";
    overlayEl.style.width = r.width + "px";
    overlayEl.style.height = r.height + "px";
    const tag = el.tagName.toLowerCase();
    const idStr = el.id ? "#" + el.id : "";
    let cls = "";
    if (el.className && typeof el.className === "string") {
      const arr = el.className.split(/\s+/).filter(Boolean).slice(0, 2);
      if (arr.length) cls = "." + arr.join(".");
    }
    const role = (el.getAttribute && el.getAttribute("role")) || "";
    labelEl.textContent = tag + idStr + cls + (role ? " [" + role + "]" : "") + "  · botão-direito = sobe (pega o modal)";
    labelEl.style.display = "block";
    labelEl.style.left = r.left + "px";
    labelEl.style.top = Math.max(0, r.top - 18) + "px";
  }

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6) {
      let part = el.nodeName.toLowerCase();
      if (el.id) { part += "#" + el.id; parts.unshift(part); break; }
      let n = 1, sib = el;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === el.nodeName) n++;
      }
      if (n > 1) part += ":nth-of-type(" + n + ")";
      if (el.className && typeof el.className === "string") {
        const cls = el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".");
        if (cls) part += "." + cls;
      }
      parts.unshift(part);
      el = el.parentNode;
    }
    return parts.join(" > ");
  }

  function onMouseMove(e) {
    const el = e.target;
    if (el === lastTarget) return;
    lastTarget = el;
    baseTarget = el;
    currentTarget = el;
    setHighlight(currentTarget);
  }

  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (window.__h2cLoading) return window.__h2cLoading;
    window.__h2cLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "http://localhost:3000/html2canvas.min.js";
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => reject(new Error("falha ao carregar html2canvas"));
      document.head.appendChild(s);
    });
    return window.__h2cLoading;
  }

  async function captureScreenshot(el) {
    try {
      const h2c = await loadHtml2Canvas();
      if (!h2c) return null;
      // Hide our overlay during capture so it doesn't show in the screenshot
      const wasOverlay = overlayEl && overlayEl.style.display;
      const wasLabel = labelEl && labelEl.style.display;
      if (overlayEl) overlayEl.style.display = "none";
      if (labelEl) labelEl.style.display = "none";
      const canvas = await h2c(el, {
        backgroundColor: null,
        scale: Math.min(window.devicePixelRatio || 1, 2),
        logging: false,
        useCORS: true,
        allowTaint: true,
      });
      if (overlayEl && wasOverlay) overlayEl.style.display = wasOverlay;
      if (labelEl && wasLabel) labelEl.style.display = wasLabel;
      // Limit max size for transport
      const MAX = 800;
      let out = canvas;
      if (canvas.width > MAX || canvas.height > MAX) {
        const ratio = Math.min(MAX / canvas.width, MAX / canvas.height);
        const tmp = document.createElement("canvas");
        tmp.width = Math.round(canvas.width * ratio);
        tmp.height = Math.round(canvas.height * ratio);
        tmp.getContext("2d").drawImage(canvas, 0, 0, tmp.width, tmp.height);
        out = tmp;
      }
      return out.toDataURL("image/png");
    } catch (e) {
      return null;
    }
  }

  // Captura estilos COMPUTADOS (valores CSS resolvidos: cores reais, raio, sombra,
  // padding, tipografia) do elemento + título + botões — pro agente replicar exato
  // sem precisar adivinhar pela imagem.
  function pickStyles(el) {
    const WANT = ["display", "flexDirection", "gap", "backgroundColor", "color", "border", "borderRadius",
      "boxShadow", "padding", "width", "maxWidth", "minWidth", "fontFamily", "fontSize", "fontWeight",
      "lineHeight", "letterSpacing", "textAlign", "backdropFilter", "opacity", "outline"];
    const IGNORE = ["none", "normal", "auto", "0px", "static", "rgba(0, 0, 0, 0)", "0", ""];
    function snap(node) {
      const cs = getComputedStyle(node), o = {};
      WANT.forEach(function (p) {
        let v = cs[p];
        if (v && IGNORE.indexOf(String(v).trim()) < 0) o[p] = String(v).trim().slice(0, 80);
      });
      return o;
    }
    const out = { self: snap(el) };
    try {
      const h = el.querySelector("h1,h2,h3,[role=heading]");
      if (h) out.heading = { text: (h.textContent || "").trim().slice(0, 40), style: snap(h) };
      const btns = Array.prototype.slice.call(el.querySelectorAll("button,[role=button]")).slice(0, 4)
        .map(function (b) { return { text: (b.textContent || "").trim().slice(0, 24) || (b.getAttribute("aria-label") || "").slice(0, 24), style: snap(b) }; });
      if (btns.length) out.buttons = btns;
    } catch (_) {}
    return out;
  }

  // Lê os TOKENS do design system (variáveis CSS --color/--radius/--shadow/... do
  // :root) das folhas de estilo, pro agente usar as MESMAS variáveis em vez de
  // valores resolvidos crus.
  function pickTokens() {
    const out = {};
    function walk(rules, depth) {
      if (depth > 4 || !rules) return;
      for (let r = 0; r < rules.length; r++) {
        const rule = rules[r];
        if (rule.selectorText && (rule.selectorText.indexOf(":root") >= 0 || rule.selectorText === "html" || rule.selectorText === ".dark")) {
          const st = rule.style;
          for (let i = 0; i < st.length; i++) {
            const prop = st[i];
            if (prop && prop.indexOf("--") === 0) {
              const val = st.getPropertyValue(prop).trim();
              if (val && !out[prop]) out[prop] = val.slice(0, 60);
            }
          }
        }
        if (rule.cssRules) { try { walk(rule.cssRules, depth + 1); } catch (_) {} }
      }
    }
    try {
      for (let s = 0; s < document.styleSheets.length; s++) {
        let rules; try { rules = document.styleSheets[s].cssRules; } catch (_) { continue; } // cross-origin
        walk(rules, 0);
      }
    } catch (_) {}
    // filtra pros tokens de design e limita a ~50
    const keep = {}; let n = 0;
    const RE = /--(color|bg|fg|surface|border|ring|radius|shadow|space|spacing|font|text|muted|primary|secondary|accent|success|danger|warning|destructive|foreground|background|card|popover|input|gap)/i;
    for (const k in out) { if (RE.test(k)) { keep[k] = out[k]; if (++n >= 50) break; } }
    return Object.keys(keep).length ? keep : out;
  }

  async function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = currentTarget || e.target; // usa o alvo navegado (↑/↓), não só o mais interno
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const classes = (el.className && typeof el.className === "string")
      ? el.className.split(/\s+/).filter(Boolean) : [];
    // Sobe na árvore procurando data-jarvis-src (injetado pelo babel-jarvis-tag em DSs)
    let jarvisSrc = null, jarvisEl = el;
    while (jarvisEl && jarvisEl !== document.body) {
      if (jarvisEl.getAttribute && jarvisEl.getAttribute("data-jarvis-src")) {
        jarvisSrc = jarvisEl.getAttribute("data-jarvis-src");
        break;
      }
      jarvisEl = jarvisEl.parentElement;
    }
    const payload = {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes,
      text: (el.textContent || "").trim().slice(0, 200),
      outerHtml: (el.outerHTML || "").slice(0, 6000),
      styles: pickStyles(el), // estilos COMPUTADOS (valores reais) p/ replicar exato
      tokens: pickTokens(),   // variáveis --color/--radius/... do design system
      selector: cssPath(el),
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      pageUrl: location.href,
      screenshot: null,
      jarvisSrc,
    };
    // Disable picker UI immediately so user feedback is fast
    disable();
    payload.screenshot = await captureScreenshot(el);
    try { window.parent.postMessage({ type: "jarvis-picker:picked", payload }, "*"); } catch (_) {}
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      disable();
      try { window.parent.postMessage({ type: "jarvis-picker:cancelled" }, "*"); } catch (_) {}
      return;
    }
    // ↑ sobe pro elemento PAI (ex: pra pegar o modal inteiro em vez do botão de dentro)
    if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") {
      e.preventDefault(); e.stopPropagation();
      const par = currentTarget && currentTarget.parentElement;
      if (par && par !== document.body && par !== document.documentElement) {
        currentTarget = par;
        setHighlight(currentTarget);
      }
      return;
    }
    // ↓ volta pro elemento mais interno (em direção ao que estava sob o cursor)
    if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") {
      e.preventDefault(); e.stopPropagation();
      if (currentTarget && baseTarget && currentTarget !== baseTarget) {
        const child = Array.prototype.find.call(currentTarget.children || [], (c) => c === baseTarget || c.contains(baseTarget));
        if (child) { currentTarget = child; setHighlight(currentTarget); }
      }
      return;
    }
  }

  // Scroll do mouse navega a árvore (confiável no iframe — não depende de foco do
  // teclado): scroll pra CIMA = elemento PAI (ex: pegar o modal inteiro), pra BAIXO = filho.
  function onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.deltaY < 0) {
      const par = currentTarget && currentTarget.parentElement;
      if (par && par !== document.body && par !== document.documentElement) { currentTarget = par; setHighlight(currentTarget); }
    } else if (e.deltaY > 0) {
      if (currentTarget && baseTarget && currentTarget !== baseTarget) {
        const child = Array.prototype.find.call(currentTarget.children || [], (c) => c === baseTarget || c.contains(baseTarget));
        if (child) { currentTarget = child; setHighlight(currentTarget); }
      }
    }
  }

  // Botão DIREITO = sobe um nível (método mais confiável: não depende de foco do
  // teclado nem briga com o scroll-lock do modal). Esquerdo = seleciona.
  function onContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const par = currentTarget && currentTarget.parentElement;
    if (par && par !== document.body && par !== document.documentElement) { currentTarget = par; setHighlight(currentTarget); }
    return false;
  }

  function enable() {
    if (active) return;
    active = true;
    ensureOverlay();
    document.documentElement.style.cursor = "crosshair";
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("contextmenu", onContextMenu, true);
  }

  function disable() {
    if (!active) return;
    active = false;
    document.documentElement.style.cursor = "";
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    document.removeEventListener("wheel", onWheel, { capture: true, passive: false });
    document.removeEventListener("contextmenu", onContextMenu, true);
    if (overlayEl) overlayEl.style.display = "none";
    if (labelEl) labelEl.style.display = "none";
    lastTarget = null;
  }

  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "jarvis-picker:enable") enable();
    else if (d.type === "jarvis-picker:disable") disable();
  });

  try { window.parent.postMessage({ type: "jarvis-picker:ready" }, "*"); } catch (_) {}
})();
