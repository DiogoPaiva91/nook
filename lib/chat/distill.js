const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HUB_ROOT = process.env.HUB_ROOT || "/home/diogo/dev/_hub";
const MEM_DIR = path.join(HUB_ROOT, "memorias");

const DISTILL_PROMPT = `Você é um destilador de memórias de longo prazo para o assistente Jarvis Código.

Receberá uma conversa entre o Usuário e o Assistente. Sua tarefa é extrair APENAS fatos persistentes que ajudem o Jarvis em conversas futuras. Ignore o vai-e-vem, foque no que sobrevive ao tempo.

Categorias a extrair (omita as que não se aplicam):
- preferencias: como o usuário gosta de trabalhar, padrões de código, ferramentas favoritas
- decisoes: escolhas técnicas tomadas com a justificativa (o porquê é mais valioso que o quê)
- aprendizados: bugs corrigidos, armadilhas identificadas, lições — com causa raiz
- contexto_projeto: arquitetura, dependências, estado do projeto não óbvios pelo código
- snippets: trechos de código reutilizáveis com contexto de quando aplicar
- pendencias: itens explicitamente abertos pelo usuário

Retorne EXCLUSIVAMENTE um JSON válido nesta forma (sem markdown, sem comentários, sem texto antes ou depois):
{
  "titulo": "string curta descrevendo o tema central",
  "resumo": "1-2 frases sobre a conversa",
  "fatos": [
    { "categoria": "preferencias|decisoes|aprendizados|contexto_projeto|snippets|pendencias", "texto": "fato persistente em 1-3 frases", "tags": ["tag1","tag2"] }
  ]
}

Se a conversa não tiver nenhum fato persistente (foi trivial), retorne {"titulo":"","resumo":"","fatos":[]}.`;

function dateOnly(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "memoria";
}

function buildTranscript(msgs) {
  return msgs
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => {
      const role = m.role === "user" ? "Usuário" : "Assistente";
      return `${role}: ${(m.content || "").trim()}`;
    })
    .join("\n\n");
}

function callClaude(prompt, model = "sonnet") {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--model", model, "--permission-mode", "bypassPermissions"];
    const proc = spawn("claude", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout.on("data", c => out += c.toString());
    proc.stderr.on("data", c => err += c.toString());
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      resolve(out.trim());
    });
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("destilação timeout")); }, 120000);
  });
}

function extractJson(text) {
  if (!text) throw new Error("resposta vazia");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("json não encontrado na resposta");
  return JSON.parse(body.slice(start, end + 1));
}

function renderMemory(chat, distilled) {
  const fatos = Array.isArray(distilled.fatos) ? distilled.fatos : [];
  const tagsSet = new Set(["memoria"]);
  for (const f of fatos) {
    for (const t of (f.tags || [])) tagsSet.add(slugify(t));
  }
  const fm = [
    "---",
    `titulo: ${JSON.stringify(distilled.titulo || chat.title || "Memória")}`,
    `data: ${dateOnly(Date.now())}`,
    `fonte: jarvis-destilacao`,
    `conversa_id: ${chat.id}`,
    `tags: [${Array.from(tagsSet).join(", ")}]`,
    "---",
    "",
  ].join("\n");

  const partes = [`# ${distilled.titulo || chat.title || "Memória"}`, ""];
  if (distilled.resumo) partes.push(distilled.resumo, "");

  const grupos = {};
  for (const f of fatos) {
    const cat = f.categoria || "outros";
    (grupos[cat] = grupos[cat] || []).push(f);
  }
  const ordem = ["preferencias", "decisoes", "aprendizados", "contexto_projeto", "snippets", "pendencias"];
  const todasCats = [...ordem.filter(c => grupos[c]), ...Object.keys(grupos).filter(c => !ordem.includes(c))];

  for (const cat of todasCats) {
    partes.push(`## ${cat}`, "");
    for (const f of grupos[cat]) {
      const tags = (f.tags && f.tags.length) ? ` _(${f.tags.join(", ")})_` : "";
      partes.push(`- ${f.texto}${tags}`);
    }
    partes.push("");
  }

  return fm + partes.join("\n");
}

async function distillConversation(workerId, { model = "sonnet" } = {}) {
  const chatStore = require("./conversations");
  const registry = require("../workers/registry");
  let chat = chatStore.getChat(workerId);
  let msgs = chatStore.getMessages(workerId);
  if (!chat) {
    const w = registry.get(workerId);
    if (!w) throw new Error("conversa não encontrada");
    chat = w.toJSON();
    msgs = w.getHistory();
  }
  msgs = msgs || [];
  if (msgs.length < 2) throw new Error("conversa curta demais para destilar");

  const transcript = buildTranscript(msgs);
  const fullPrompt = `${DISTILL_PROMPT}\n\n---\nCONVERSA:\n\n${transcript}`;
  const raw = await callClaude(fullPrompt, model);
  const distilled = extractJson(raw);

  if (!distilled.fatos || distilled.fatos.length === 0) {
    return { ok: true, written: false, reason: "sem fatos persistentes" };
  }

  if (!fs.existsSync(MEM_DIR)) fs.mkdirSync(MEM_DIR, { recursive: true });
  const slug = slugify(distilled.titulo || chat.title);
  const shortId = String(chat.id).replace(/^w_/, "").slice(0, 8);
  const target = path.join(MEM_DIR, `${dateOnly(Date.now())}-${slug}--${shortId}.md`);
  fs.writeFileSync(target, renderMemory(chat, distilled), "utf8");

  // Fire-and-forget reindex so memória vira RAG ativo na próxima conversa
  fetch("http://localhost:3001/embed/reindex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});

  return { ok: true, written: true, path: target, fatos: distilled.fatos.length };
}

module.exports = { distillConversation };
