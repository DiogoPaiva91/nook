const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HUB_ROOT = process.env.HUB_ROOT || "/home/diogo/dev/_hub";
const PROFILE_DIR = path.join(HUB_ROOT, "usuario");
const PROFILE_PATH = path.join(PROFILE_DIR, "perfil.md");
const MEM_DIR = path.join(HUB_ROOT, "memorias");
const CONV_DIR = path.join(HUB_ROOT, "conversas");

const PROFILE_PROMPT = `Você está sintetizando um perfil cumulativo do usuário Diogo a partir de memórias e conversas recentes do Jarvis.

Receberá:
1. Memórias destiladas (já são síntese de conversas anteriores)
2. Trechos de conversas recentes

Sua tarefa: produzir um perfil compacto que ajude o Jarvis a colaborar melhor em futuras conversas. Foque em sinais persistentes, não eventos pontuais.

Estrutura desejada (omita seções vazias):

## Como o Diogo trabalha
- estilo de comunicação preferido
- nível de detalhe esperado nas respostas
- ritmo (rápido/cuidadoso, validar antes/depois, etc)

## Stack e ferramentas
- linguagens/frameworks/serviços que ele usa
- preferências fortes (X em vez de Y porque Z)

## Padrões recorrentes
- decisões arquiteturais que ele costuma tomar
- antipattern que ele rejeita

## Projeto principal e contexto
- projetos em foco hoje
- objetivos amplos de médio prazo

## Pendências persistentes
- itens em aberto que aparecem em várias conversas

## Nota
- 1-2 frases de meta-observação útil pro Jarvis (ex: "prefere PT-BR mas escreve código em inglês")

Tom: terso, factual, em português brasileiro. Evite generalidades vazias ("gosta de qualidade"). Cite exemplos concretos quando ajudarem.

Retorne SOMENTE o markdown do perfil (sem cercas \`\`\`, sem JSON, sem comentário antes ou depois).`;

function readMemorias(maxFiles = 30) {
  if (!fs.existsSync(MEM_DIR)) return "";
  const files = fs.readdirSync(MEM_DIR).filter(f => f.endsWith(".md"))
    .map(f => ({ f, m: fs.statSync(path.join(MEM_DIR, f)).mtime }))
    .sort((a, b) => b.m - a.m).slice(0, maxFiles);
  const parts = [];
  for (const { f } of files) {
    try {
      const c = fs.readFileSync(path.join(MEM_DIR, f), "utf8");
      // Strip frontmatter
      const stripped = c.replace(/^---[\s\S]*?\n---\n+/, "");
      parts.push(`### ${f}\n${stripped.slice(0, 1200)}`);
    } catch {}
  }
  return parts.join("\n\n---\n\n");
}

function readConversas(maxFiles = 15, maxCharsEach = 1500) {
  if (!fs.existsSync(CONV_DIR)) return "";
  const files = fs.readdirSync(CONV_DIR).filter(f => f.endsWith(".md"))
    .map(f => ({ f, m: fs.statSync(path.join(CONV_DIR, f)).mtime }))
    .sort((a, b) => b.m - a.m).slice(0, maxFiles);
  const parts = [];
  for (const { f } of files) {
    try {
      const c = fs.readFileSync(path.join(CONV_DIR, f), "utf8");
      const stripped = c.replace(/^---[\s\S]*?\n---\n+/, "");
      parts.push(`### ${f}\n${stripped.slice(0, maxCharsEach)}`);
    } catch {}
  }
  return parts.join("\n\n---\n\n");
}

function callClaude(prompt, model = "sonnet") {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--model", model, "--permission-mode", "bypassPermissions"];
    const proc = spawn("claude", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    proc.stdout.on("data", (c) => out += c.toString());
    proc.stderr.on("data", (c) => err += c.toString());
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
      resolve(out.trim());
    });
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("profile timeout")); }, 180000);
  });
}

async function generateProfile({ model = "sonnet" } = {}) {
  const memorias = readMemorias();
  const conversas = readConversas();
  if (!memorias && !conversas) throw new Error("sem memórias/conversas para sintetizar");
  const fullPrompt = `${PROFILE_PROMPT}\n\n# MEMÓRIAS DESTILADAS\n\n${memorias || "(vazio)"}\n\n# CONVERSAS RECENTES\n\n${conversas || "(vazio)"}`;
  const md = await callClaude(fullPrompt, model);
  if (!md || md.length < 50) throw new Error("perfil gerado vazio/curto demais");
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const fm = [
    "---",
    `titulo: "Perfil cumulativo do Diogo"`,
    `atualizado: ${new Date().toISOString()}`,
    `fonte: jarvis-profile`,
    "tags: [perfil, usuario]",
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(PROFILE_PATH, fm + md + "\n", "utf8");
  fetch("http://localhost:3001/embed/reindex", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  return { ok: true, path: PROFILE_PATH, length: md.length };
}

function getProfile() {
  if (!fs.existsSync(PROFILE_PATH)) return null;
  const content = fs.readFileSync(PROFILE_PATH, "utf8");
  const stripped = content.replace(/^---[\s\S]*?\n---\n+/, "");
  return { content: stripped, raw: content, path: PROFILE_PATH };
}

module.exports = { generateProfile, getProfile, PROFILE_PATH };
