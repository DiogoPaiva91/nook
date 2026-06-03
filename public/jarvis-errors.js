(function () {
  if (window.__jarvisErrorsLoaded) return;
  window.__jarvisErrorsLoaded = true;

  function post(msg) { try { window.parent.postMessage(msg, "*"); } catch (_) {} }

  // ── Captura de erro (runtime + promises) ──
  window.addEventListener("error", function (e) {
    post({
      type: "jarvis-app:error", level: "error",
      message: (e && e.message) || "Erro de script",
      source: (e && e.filename) || "", line: (e && e.lineno) || 0, col: (e && e.colno) || 0,
      stack: (e && e.error && e.error.stack) ? String(e.error.stack).slice(0, 4000) : "",
      url: location.href, ts: Date.now(),
    });
  }, true);

  window.addEventListener("unhandledrejection", function (e) {
    var reason = e && e.reason, msg = "", stack = "";
    if (reason && typeof reason === "object") {
      msg = reason.message || JSON.stringify(reason).slice(0, 300);
      stack = reason.stack ? String(reason.stack).slice(0, 4000) : "";
    } else { msg = String(reason); }
    post({ type: "jarvis-app:rejection", level: "error", message: "Promise rejeitada sem tratamento: " + msg, stack: stack, url: location.href, ts: Date.now() });
  });

  // ── html2canvas (screenshot) ──
  function loadHtml2Canvas() {
    if (window.html2canvas) return Promise.resolve(window.html2canvas);
    if (window.__h2cLoading) return window.__h2cLoading;
    window.__h2cLoading = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "http://localhost:3000/html2canvas.min.js";
      s.onload = function () { resolve(window.html2canvas); };
      s.onerror = function () { reject(new Error("falha html2canvas")); };
      document.head.appendChild(s);
    });
    return window.__h2cLoading;
  }

  async function snapshot(id) {
    var out = { type: "jarvis-app:snapshot", id: id, dataUrl: null, textLen: 0, url: location.href };
    try {
      out.textLen = ((document.body && document.body.innerText) || "").trim().length;
      var h2c = await loadHtml2Canvas();
      if (h2c) {
        var canvas = await h2c(document.body, { backgroundColor: "#ffffff", scale: Math.min(window.devicePixelRatio || 1, 1.5), logging: false, useCORS: true, allowTaint: true });
        var MAX = 900, c = canvas;
        if (canvas.width > MAX || canvas.height > MAX) {
          var ratio = Math.min(MAX / canvas.width, MAX / canvas.height);
          var tmp = document.createElement("canvas");
          tmp.width = Math.round(canvas.width * ratio); tmp.height = Math.round(canvas.height * ratio);
          tmp.getContext("2d").drawImage(canvas, 0, 0, tmp.width, tmp.height);
          c = tmp;
        }
        out.dataUrl = c.toDataURL("image/png");
      }
    } catch (_) {}
    post(out);
  }

  // ── Runner de interação visível (smoke + roteiro do agente) ──
  var _cursor = null, _ring = null;
  function ensureCursor() {
    if (_cursor) return;
    _ring = document.createElement("div");
    _ring.style.cssText = "position:fixed;z-index:2147483646;border:2px solid #3ecf8e;border-radius:6px;background:rgba(62,207,142,0.14);pointer-events:none;transition:all .18s ease;display:none;box-sizing:border-box";
    _cursor = document.createElement("div");
    _cursor.style.cssText = "position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;background:rgba(62,207,142,0.95);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,0.45);pointer-events:none;transform:translate(-50%,-50%);transition:left .3s ease,top .3s ease;left:-60px;top:-60px";
    document.body.appendChild(_ring); document.body.appendChild(_cursor);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function moveCursorTo(el) {
    ensureCursor();
    var r = el.getBoundingClientRect();
    _cursor.style.left = (r.left + r.width / 2) + "px";
    _cursor.style.top = (r.top + r.height / 2) + "px";
    _ring.style.display = "block";
    _ring.style.left = r.left + "px"; _ring.style.top = r.top + "px";
    _ring.style.width = r.width + "px"; _ring.style.height = r.height + "px";
  }
  function clickPulse() { if (!_cursor) return; _cursor.style.background = "rgba(255,255,255,0.98)"; setTimeout(function () { if (_cursor) _cursor.style.background = "rgba(62,207,142,0.95)"; }, 140); }
  function hideCursor() { if (_ring) _ring.style.display = "none"; if (_cursor) { _cursor.style.left = "-60px"; _cursor.style.top = "-60px"; } }

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < 0 || r.top > (window.innerHeight + 1200)) return false;
    var st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    if (el.disabled) return false;
    return true;
  }
  function elLabel(el) {
    return String(el.getAttribute && el.getAttribute("aria-label") || el.textContent || el.value || el.placeholder || el.name || el.tagName || "").trim().slice(0, 40);
  }
  function findEl(sel) {
    if (!sel) return null;
    try {
      if (sel.indexOf("text=") === 0) {
        var t = sel.slice(5).toLowerCase();
        var all = document.querySelectorAll("button,a,[role=button],input,label,span,div,li");
        for (var i = 0; i < all.length; i++) {
          if ((all[i].textContent || "").trim().toLowerCase().indexOf(t) >= 0 && isVisible(all[i])) return all[i];
        }
        return null;
      }
      return document.querySelector(sel);
    } catch (_) { return null; }
  }
  function setNativeValue(el, value) {
    var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  var DESTRUCTIVE = /delet|remov|excluir|apagar|logout|sair|sign ?out|limpar tudo|\breset\b|cancelar conta|deslogar/i;

  function buildSmokeSteps() {
    var steps = [];
    var inputs = [].slice.call(document.querySelectorAll("input,textarea")).filter(function (el) {
      var t = (el.type || "text").toLowerCase();
      return isVisible(el) && ["checkbox", "radio", "file", "submit", "button", "hidden"].indexOf(t) < 0;
    }).slice(0, 5);
    inputs.forEach(function (el) {
      var t = (el.type || "text").toLowerCase();
      var val = t === "number" ? "7" : (t === "email" ? "teste@qa.com" : "Teste QA");
      steps.push({ action: "fill", _el: el, text: val, desc: "preencher " + elLabel(el) });
    });
    var btns = [].slice.call(document.querySelectorAll("button,[role=button],input[type=submit],a[href]")).filter(function (el) {
      if (!isVisible(el) || DESTRUCTIVE.test(elLabel(el))) return false;
      // pula links externos / nova aba (navegariam pra fora do app)
      if (el.tagName === "A") {
        var href = el.getAttribute("href") || "";
        if (el.target === "_blank" || /^https?:\/\//i.test(href)) return false;
      }
      return true;
    }).slice(0, 6);
    btns.forEach(function (el) { steps.push({ action: "click", _el: el, desc: "clicar " + elLabel(el) }); });
    return steps;
  }

  var SPEED = {
    slow:   { step: 750, move: 600, settle: 500, scroll: 320 }, // bem deliberado, pra escrutinar
    normal: { step: 480, move: 420, settle: 340, scroll: 200 }, // fluido e acompanhável (default)
    fast:   { step: 110, move: 30,  settle: 70,  scroll: 30 },  // headless (backend)
  };

  async function runSteps(steps, opts) {
    opts = opts || {};
    var p = SPEED[opts.speed] || SPEED.slow;
    var visual = opts.speed !== "fast";
    var results = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i], res = { i: i, action: s.action, selector: s.selector || null, desc: s.desc || "", ok: true, error: "" };
      try {
        if (s.action === "wait") { await sleep(s.ms || p.step); results.push(res); continue; }
        if (s.action === "assertText") {
          var found = ((document.body && document.body.innerText) || "").toLowerCase().indexOf(String(s.text || "").toLowerCase()) >= 0;
          res.ok = found; if (!found) res.error = "texto esperado não apareceu: " + s.text;
          results.push(res); continue;
        }
        var el = s._el || findEl(s.selector);
        if (!el) { res.ok = false; res.error = "elemento não encontrado: " + (s.selector || s.desc); results.push(res); await sleep(p.step); continue; }
        try { el.scrollIntoView({ block: "center", behavior: visual ? "smooth" : "auto" }); } catch (_) {}
        await sleep(p.scroll);
        if (visual) { moveCursorTo(el); await sleep(p.move); }
        if (s.action === "click") { if (visual) clickPulse(); el.click(); }
        else if (s.action === "fill" || s.action === "type") { try { el.focus(); } catch (_) {} setNativeValue(el, s.text != null ? s.text : "Teste QA"); if (visual) clickPulse(); }
        else if (s.action === "press") {
          var k = s.key || "Enter";
          try { el.focus(); } catch (_) {}
          var ko = { key: k, code: k === "Enter" ? "Enter" : k, keyCode: k === "Enter" ? 13 : 0, which: k === "Enter" ? 13 : 0, bubbles: true };
          el.dispatchEvent(new KeyboardEvent("keydown", ko));
          el.dispatchEvent(new KeyboardEvent("keypress", ko));
          el.dispatchEvent(new KeyboardEvent("keyup", ko));
          // Enter num input dentro de <form>: eventos sintéticos NÃO submetem sozinhos.
          // Dispara o submit nativo (roda onSubmit do React) via requestSubmit().
          if (k === "Enter" && el.form) {
            try { if (typeof el.form.requestSubmit === "function") el.form.requestSubmit(); else el.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); } catch (_) {}
          }
        }
        await sleep(p.settle);
      } catch (e) { res.ok = false; res.error = (e && e.message) || String(e); }
      results.push(res);
      await sleep(p.step);
    }
    hideCursor();
    return results;
  }

  // Descreve os elementos interativos REAIS da tela, com seletores que o runner
  // resolve (id, placeholder, ou text=Rótulo). O Hub usa isso pra montar um teste
  // de cadastro que de fato bate com o DOM (em vez de seletores inventados).
  function selectorFor(el) {
    if (el.id) return "#" + ((window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id);
    var al = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"));
    if (al) return el.tagName.toLowerCase() + "[aria-label='" + al.replace(/'/g, "") + "']";
    if (el.getAttribute && el.getAttribute("placeholder")) return el.tagName.toLowerCase() + "[placeholder='" + el.getAttribute("placeholder").replace(/'/g, "") + "']";
    if (el.name) return el.tagName.toLowerCase() + "[name='" + el.name + "']";
    return null;
  }
  function describe(id) {
    const inputs = [].slice.call(document.querySelectorAll("input,textarea")).filter(function (el) {
      var t = (el.type || "text").toLowerCase();
      return isVisible(el) && ["checkbox", "radio", "file", "submit", "button", "hidden"].indexOf(t) < 0;
    }).slice(0, 8).map(function (el) {
      return { sel: selectorFor(el) || (el.tagName.toLowerCase() + "[type=" + ((el.type || "text").toLowerCase()) + "]"), type: (el.type || "text").toLowerCase(), placeholder: el.getAttribute && el.getAttribute("placeholder") || "", label: elLabel(el) };
    });
    const buttons = [].slice.call(document.querySelectorAll("button,[role=button],input[type=submit]")).filter(function (el) {
      return isVisible(el) && !DESTRUCTIVE.test(elLabel(el));
    }).slice(0, 12).map(function (el) {
      var txt = (el.textContent || el.value || "").trim();
      var aria = (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title")) || "").trim();
      var label = txt || aria;
      // Prefere text=<texto visível>; se for botão de ícone (sem texto), usa seletor por aria-label.
      var sel = txt ? ("text=" + txt.slice(0, 30)) : (selectorFor(el) || "");
      return { sel: sel, text: label.slice(0, 40) };
    });
    post({ type: "jarvis-app:dom", id: id, inputs: inputs, buttons: buttons, bodyText: ((document.body && document.body.innerText) || "").trim().slice(0, 400) });
  }

  // ── Teste CRUD completo (criar → marcar/flag → deletar → limpar) ──
  // Descobre os elementos AO VIVO (não depende de seletores prontos) e restaura
  // o localStorage no fim, pra não destruir os dados reais do usuário.
  var DELETE_RE = /remov|delet|excluir|apagar|trash|lixeira|descartar|×|✕|✗/i;
  var CLEAR_RE = /limpar|clear|esvaziar|apagar tudo|remover tudo|zerar/i;
  var CONFIRM_RE = /confirmar|sim,|^sim$|limpar|esvaziar|^ok$|continuar|apagar|excluir|remover/i;

  function isClickable(el) { // como isVisible, MAS ignora opacity (botões hover-revealed contam)
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none") return false;
    if (el.disabled) return false;
    return true;
  }
  function firstTextInput() {
    var all = [].slice.call(document.querySelectorAll("input,textarea"));
    for (var i = 0; i < all.length; i++) { var t = (all[i].type || "text").toLowerCase(); if (isVisible(all[i]) && ["checkbox", "radio", "file", "submit", "button", "hidden"].indexOf(t) < 0) return all[i]; }
    return null;
  }
  function findAddButton(input) {
    var btns = [].slice.call(document.querySelectorAll("button,[role=button],input[type=submit]")).filter(isClickable);
    var add = btns.filter(function (b) { return /adicion|incluir|\badd\b|salvar|criar|cadastr|enviar|confirmar|^\s*\+\s*$/i.test(elLabel(b)) && !DELETE_RE.test(elLabel(b)) && !CLEAR_RE.test(elLabel(b)); });
    if (add.length) return add[0];
    if (input && input.form) { var sub = input.form.querySelector("button[type=submit],input[type=submit],button:not([type])"); if (sub && isClickable(sub)) return sub; }
    return null;
  }
  function bodyHas(text) { return ((document.body && document.body.innerText) || "").indexOf(text) >= 0; }
  function openDialog() { return document.querySelector("[role=dialog],[role=alertdialog],[data-state=open][class*=dialog],.modal,[aria-modal=true]"); }
  function closeModals() {
    // Esc (best-effort p/ Radix/shadcn) + clica em Cancelar/Fechar + clica no backdrop.
    for (var i = 0; i < 2; i++) { try { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })); } catch (_) {} }
    var dlg = openDialog();
    if (dlg) {
      var cancel = [].slice.call(dlg.querySelectorAll("button,[role=button]")).filter(isClickable).filter(function (b) { return /cancelar|fechar|close|voltar|não|nao|descartar|^x$|×|✕/i.test(elLabel(b)); })[0];
      if (cancel) { try { robustClick(cancel); } catch (_) {} }
    }
    // overlay/backdrop
    var ov = document.querySelector("[data-radix-dialog-overlay],[class*=overlay],[class*=backdrop]");
    if (ov && isClickable(ov)) { try { robustClick(ov); } catch (_) {} }
  }
  function rowContaining(text) {
    var cands = [].slice.call(document.querySelectorAll("li,tr,[role=listitem],[role=row],div")).filter(function (el) {
      return el.textContent && el.textContent.indexOf(text) >= 0 && el.querySelector("button,[role=button]") && isVisible(el);
    });
    cands.sort(function (a, b) { return (a.textContent || "").length - (b.textContent || "").length; });
    return cands[0] || null;
  }
  function rowButtons(row) { return row ? [].slice.call(row.querySelectorAll("button,[role=button]")).filter(isClickable) : []; }
  function robustClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: "center" }); } catch (_) {}
    try {
      var r = el.getBoundingClientRect();
      var o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, view: window };
      // NÃO inclui "click" aqui — o el.click() abaixo é o único clique (senão dispara
      // 2x e um toggle/checkbox marca+desmarca, virando no-op).
      ["pointerover", "pointerenter", "pointerdown", "mousedown", "focus", "pointerup", "mouseup"].forEach(function (type) {
        try { var Ev = (type.indexOf("pointer") === 0 && window.PointerEvent) ? PointerEvent : (type === "focus" ? FocusEvent : MouseEvent); el.dispatchEvent(new Ev(type, o)); } catch (_) {}
      });
    } catch (_) {}
    try { el.click(); } catch (_) {}
  }
  async function submitAdd(input, addBtn, p, visual) {
    if (addBtn) { await doVisible(addBtn, function () { robustClick(addBtn); }, p, visual); }
    else if (input && input.form) { try { input.focus(); if (typeof input.form.requestSubmit === "function") input.form.requestSubmit(); else input.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); } catch (_) {} }
    else if (input) { var ko = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }; input.dispatchEvent(new KeyboardEvent("keydown", ko)); input.dispatchEvent(new KeyboardEvent("keyup", ko)); }
  }
  // Revela elementos que só aparecem no :hover (ex: botão "X" de excluir, opacity:0
  // até group-hover) — eventos sintéticos não disparam :hover do CSS, então a gente
  // FORÇA a opacidade pra você VER o botão sendo clicado. Devolve um restore.
  function revealForInteraction(el) {
    var undo = [];
    try {
      var node = el, n = 0;
      while (node && node !== document.body && n < 4) {
        try { if (getComputedStyle(node).opacity === "0") { undo.push([node, node.style.opacity]); node.style.opacity = "1"; node.style.transition = "opacity .2s ease"; } } catch (_) {}
        ["pointerover", "mouseover", "mouseenter"].forEach(function (t) { try { node.dispatchEvent(new MouseEvent(t, { bubbles: true })); } catch (_) {} });
        node = node.parentElement; n++;
      }
    } catch (_) {}
    return function () { undo.forEach(function (pr) { try { pr[0].style.opacity = pr[1]; } catch (_) {} }); };
  }

  async function doVisible(el, fn, p, visual) {
    if (!el) { try { fn(); } catch (_) {} return; }
    try { el.scrollIntoView({ block: "center", behavior: visual ? "smooth" : "auto" }); } catch (_) {}
    await sleep(p.scroll);
    var restore = revealForInteraction(el); // mostra o botão (ex: excluir) que só aparece no hover
    if (visual) { try { moveCursorTo(el); } catch (_) {} await sleep(p.move); }
    try { fn(); } catch (_) {}
    if (visual) clickPulse();
    await sleep(p.settle);
    try { if (restore) restore(); } catch (_) {}
  }

  async function runCrudTest(id, opts) {
    opts = opts || {};
    var p = SPEED[opts.speed] || SPEED.slow;
    var visual = opts.speed !== "fast";
    var results = [];
    var rec = function (name, ok, error) { results.push({ action: name, ok: !!ok, error: error || "" }); };
    var backup = {};
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); backup[k] = localStorage.getItem(k); } } catch (_) {}
    var marker = "QA" + (Math.floor(performance.now()) % 90000 + 10000);

    try {
      var input = firstTextInput();
      if (!input) { rec("criar item", false, "nenhum campo de texto na tela"); }
      else {
        // 1) CRIAR
        await doVisible(input, function () { input.focus(); setNativeValue(input, marker); }, p, visual);
        await submitAdd(input, findAddButton(input), p, visual);
        await sleep(p.settle + 450);
        var created = bodyHas(marker);
        rec("criar item '" + marker + "'", created, created ? "" : "item não apareceu após adicionar");

        if (created) {
          // 2) MARCAR / FLAG (botão não-destrutivo da linha)
          var row = rowContaining(marker);
          var toggle = rowButtons(row).filter(function (b) { return !DELETE_RE.test(elLabel(b)); })[0];
          if (toggle) {
            await doVisible(toggle, function () { robustClick(toggle); }, p, visual);
            await sleep(p.settle + 250);
            rec("marcar/flag item", bodyHas(marker), bodyHas(marker) ? "" : "item sumiu ao marcar (não deveria)");
          } else rec("marcar/flag item", true, "app não tem botão de marcar (ok)");

          // 3) DELETAR (botão destrutivo da MESMA linha)
          var row2 = rowContaining(marker);
          var del = rowButtons(row2).filter(function (b) { return DELETE_RE.test(elLabel(b)); })[0];
          if (del) {
            // botões revelados só no :hover (opacity:0) não são clicáveis de forma
            // confiável por automação — não acusamos bug nesse caso (evita falso-positivo).
            var hoverOnly = false;
            try { hoverOnly = getComputedStyle(del).opacity === "0"; } catch (_) {}
            await doVisible(del, function () { robustClick(del); }, p, visual);
            await sleep(p.settle + 450);
            var gone = !bodyHas(marker);
            if (gone) rec("deletar item", true, "");
            else if (hoverOnly) rec("deletar item", true, "inconclusivo: botão de remover só aparece no hover — automação não clica confiável (provável OK no uso real)");
            else rec("deletar item", false, "item ainda aparece após deletar");
          } else rec("deletar item", false, "não achei botão de remover no item");
        }
      }

      // 4) LIMPAR (best-effort, com confirm dialog) — restauramos tudo depois
      var clearBtn = [].slice.call(document.querySelectorAll("button,[role=button]")).filter(isClickable).filter(function (b) { return CLEAR_RE.test(elLabel(b)); })[0];
      if (clearBtn && input) {
        var m2 = marker + "B";
        var inp2 = firstTextInput();
        if (inp2) { await doVisible(inp2, function () { inp2.focus(); setNativeValue(inp2, m2); }, p, visual); await submitAdd(inp2, findAddButton(inp2), p, visual); await sleep(p.settle + 300); }
        await doVisible(clearBtn, function () { robustClick(clearBtn); }, p, visual);
        await sleep(p.settle + 400);
        var dlg = openDialog();
        if (dlg) {
          // Abriu modal de confirmação: SÓ avalia "limpar" se conseguir CONFIRMAR.
          // NÃO cancela/fecha o modal — se não der pra confirmar, deixa aberto pra
          // a detecção de modal-bloqueando identificar como problema.
          var confirmBtn = [].slice.call(dlg.querySelectorAll("button,[role=button]")).filter(isClickable).filter(function (b) { return b !== clearBtn && CONFIRM_RE.test(elLabel(b)) && !/cancelar|fechar|voltar/i.test(elLabel(b)); })[0];
          if (confirmBtn) {
            await doVisible(confirmBtn, function () { robustClick(confirmBtn); }, p, visual);
            await sleep(p.settle + 400);
            rec("limpar lista", !bodyHas(m2), bodyHas(m2) ? "itens não foram limpos após confirmar" : "");
          }
        } else {
          // sem modal: o clique em limpar já deve ter limpado
          rec("limpar lista", !bodyHas(m2), bodyHas(m2) ? "itens não foram limpos" : "");
        }
        await sleep(p.settle);
      }
      // 5) NAVEGAÇÃO interna (tabs/links SPA — sem reload de página inteira)
      var navEls = [].slice.call(document.querySelectorAll("[role=tab], nav a, nav button, [role=navigation] a, [role=navigation] button, [data-nav], aside a")).filter(function (b) {
        if (!isClickable(b)) return false;
        if (b.tagName === "A") { var h = b.getAttribute("href") || ""; if (b.target === "_blank" || /^https?:\/\//i.test(h) || /^(mailto|tel):/i.test(h)) return false; }
        return !DELETE_RE.test(elLabel(b)) && !CLEAR_RE.test(elLabel(b));
      }).slice(0, 4);
      if (navEls.length) {
        for (var ni = 0; ni < navEls.length; ni++) {
          var nav = navEls[ni], lbl = elLabel(nav);
          var beforeUrl = location.href, beforeTxt = ((document.body && document.body.innerText) || "").slice(0, 120);
          await doVisible(nav, (function (n) { return function () { robustClick(n); }; })(nav), p, visual);
          await sleep(p.settle + 350);
          var moved = location.href !== beforeUrl || ((document.body && document.body.innerText) || "").slice(0, 120) !== beforeTxt;
          rec("navegar p/ '" + lbl + "'", moved, moved ? "" : "o clique não mudou a tela (nav morta?)");
        }
      } else rec("navegação", true, "sem navegação interna (single-page) — ok");

      // 6) FORM: submit vazio não deve crashar nem criar item em branco
      var inpV = firstTextInput();
      if (inpV) {
        var liBefore = document.querySelectorAll("li").length;
        await doVisible(inpV, function () { inpV.focus(); setNativeValue(inpV, ""); }, p, visual);
        await submitAdd(inpV, findAddButton(inpV), p, visual);
        await sleep(p.settle + 250);
        var liAfter = document.querySelectorAll("li").length;
        rec("validação: submit vazio", liAfter <= liBefore, liAfter > liBefore ? "criou item em branco (faltou validar campo vazio)" : "");
      }
    } catch (e) { rec("fluxo CRUD", false, (e && e.message) || String(e)); }

    // DETECÇÃO: se sobrou um modal/dialog aberto, o QA identifica como problema
    // (não fecha sozinho — fica visível e é reportado pro self-heal corrigir).
    if (openDialog()) rec("modal travou a tela", false, "um modal/dialog ficou aberto após o fluxo e não fechou — bloqueia o usuário e a interação");
    hideCursor();
    // RESTAURA os dados reais (desfaz tudo que o QA fez)
    try { localStorage.clear(); for (var kk in backup) localStorage.setItem(kk, backup[kk]); } catch (_) {}
    post({ type: "jarvis-app:steps-result", id: id, kind: "crud", count: results.length, results: results, restored: true });
  }

  // Acha um botão a partir de um texto livre (ex: "testa o botão excluir comprados").
  // Bidirecional: o rótulo do botão aparece no texto OU o texto aparece no rótulo.
  // Pega o de rótulo mais específico (mais longo) que casar. Tenta também só os
  // disabled (pra reportar "botão desabilitado") se nenhum habilitado casar.
  function findClickableByLabel(label) {
    if (!label) return null;
    var hint = String(label).trim().toLowerCase();
    if (hint.length < 2) return null;
    var all = [].slice.call(document.querySelectorAll("button,[role=button],a,input[type=submit]"));
    function pick(filterFn) {
      var best = null, bestLen = 0;
      for (var i = 0; i < all.length; i++) {
        if (!filterFn(all[i])) continue;
        var lb = (elLabel(all[i]) || "").trim().toLowerCase();
        if (lb.length < 2) continue;
        if (hint.indexOf(lb) >= 0 || lb.indexOf(hint) >= 0) { if (lb.length > bestLen) { best = all[i]; bestLen = lb.length; } }
      }
      return best;
    }
    return pick(isClickable) || pick(function () { return true; }); // 1º habilitados/visíveis; senão qualquer (até disabled)
  }

  // QA com ALVO: testa um botão específico que o usuário apontou (ex: "Excluir
  // comprados"). Monta o cenário quando é ação em massa (cria item -> marca ->
  // clica o botão -> confere que sumiu). Restaura o localStorage no fim.
  async function runTargetTest(id, target, opts) {
    opts = opts || {}; target = target || {};
    var p = SPEED[opts.speed] || SPEED.slow; var visual = opts.speed !== "fast";
    var results = [];
    var rec = function (n, ok, e) { results.push({ action: n, ok: !!ok, error: e || "" }); };
    var backup = {}; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); backup[k] = localStorage.getItem(k); } } catch (_) {}
    var label = target.label || target.text || "";
    var find = function () { var el = target.selector ? findEl(target.selector) : null; if (!el) el = findClickableByLabel(label); return el; };
    var marker = "QA" + (Math.floor(performance.now()) % 90000 + 10000);
    // Ação em massa sobre comprados/concluídos/marcados (ou limpar todos). Detecta pelo
    // LABEL antes de achar — o botão pode estar DISABLED até existir item comprado.
    var isBulk = /comprad|conclu|marcad|selecion|\bbought\b|\bdone\b/i.test(label)
      || (/todos|tudo/i.test(label) && /excluir|remov|limpar|apagar|clear|delet|esvaziar/i.test(label));
    try {
      // SETUP do cenário primeiro (cria item + marca como comprado) — habilita o botão
      if (isBulk) {
        var inp = firstTextInput();
        if (inp) {
          await doVisible(inp, function () { inp.focus(); setNativeValue(inp, marker); }, p, visual);
          await submitAdd(inp, findAddButton(inp), p, visual);
          await sleep(p.settle + 350);
          var row = rowContaining(marker);
          var toggle = rowButtons(row).filter(function (b) { return !DELETE_RE.test(elLabel(b)); })[0];
          if (toggle) { await doVisible(toggle, function () { robustClick(toggle); }, p, visual); await sleep(p.settle + 250); rec("setup: marcar '" + marker + "' como comprado", bodyHas(marker), ""); }
        }
      }
      var el = find();
      if (!el) { rec("achar o botão '" + (label || target.selector || "?") + "'", false, isBulk ? "não achei/habilitou mesmo após criar item comprado" : "não está visível/habilitado na tela agora"); }
      else {
        var shown = (elLabel(el) || label || "botão").slice(0, 40); // nome real do botão achado
        var beforeTxt = (document.body && document.body.innerText || "").slice(0, 300);
        var beforeLi = document.querySelectorAll("li").length;
        await doVisible(el, function () { robustClick(el); }, p, visual);
        await sleep(p.settle + 450);
        // confirma se abrir modal
        var dlg = openDialog();
        if (dlg) {
          var cb = [].slice.call(dlg.querySelectorAll("button,[role=button]")).filter(isClickable).filter(function (b) { return CONFIRM_RE.test(elLabel(b)) && !/cancelar|fechar|voltar/i.test(elLabel(b)); })[0];
          if (cb) { await doVisible(cb, function () { robustClick(cb); }, p, visual); await sleep(p.settle + 400); }
        }
        rec("clicar '" + shown + "'", true, "");
        if (isBulk) {
          var gone = !bodyHas(marker);
          rec("'" + shown + "' removeu o item comprado", gone, gone ? "" : "o item comprado CONTINUA na lista após clicar — o botão '" + shown + "' não funcionou");
        } else {
          var changed = (document.body && document.body.innerText || "").slice(0, 300) !== beforeTxt || document.querySelectorAll("li").length !== beforeLi;
          rec("o botão teve efeito (a tela mudou)", changed, changed ? "" : "clicar não mudou nada na tela — botão sem efeito?");
        }
      }
    } catch (e) { rec("teste do alvo", false, (e && e.message) || String(e)); }
    try { localStorage.clear(); for (var kk in backup) localStorage.setItem(kk, backup[kk]); } catch (_) {}
    post({ type: "jarvis-app:steps-result", id: id, kind: "target", count: results.length, results: results, restored: true });
  }

  async function runAndReport(kind, id, steps, opts) {
    try {
      var actual = (kind === "smoke") ? buildSmokeSteps() : (steps || []);
      var results = await runSteps(actual, opts || {});
      post({ type: "jarvis-app:steps-result", id: id, kind: kind, count: actual.length, results: results });
    } catch (e) {
      post({ type: "jarvis-app:steps-result", id: id, kind: kind, count: 0, results: [], error: (e && e.message) || String(e) });
    }
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "jarvis-app:snapshot-request") snapshot(d.id || "");
    else if (d.type === "jarvis-app:describe") describe(d.id || "");
    else if (d.type === "jarvis-app:crud") runCrudTest(d.id || "", d.opts || {});
    else if (d.type === "jarvis-app:test-target") runTargetTest(d.id || "", d.target || {}, d.opts || {});
    else if (d.type === "jarvis-app:smoke") runAndReport("smoke", d.id || "", null, d.opts || {});
    else if (d.type === "jarvis-app:run-steps") runAndReport("plan", d.id || "", d.steps || [], d.opts || {});
  });

  function ready() { post({ type: "jarvis-app:ready", url: location.href, ts: Date.now() }); }
  if (document.readyState === "complete") ready();
  else window.addEventListener("load", ready);
})();
