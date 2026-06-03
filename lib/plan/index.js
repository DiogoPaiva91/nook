const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const HUB_ROOT = process.env.HUB_ROOT || "/home/diogo/dev/_hub";
const PLAN_DIR = path.join(HUB_ROOT, "planos");

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "plano";
}

function dateOnly(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const PLAN_PROMPT = `Você é um arquiteto de planejamento. Receberá um objetivo (goal) e contexto opcional do projeto. Produza um plano executável em etapas.

Regras:
- Decomponha em 3-12 etapas concretas, cada uma realizável em 5-30 min
- Cada etapa tem: titulo curto, descricao executável (verbos imperativos), deps (ids de etapas que devem completar antes), criterio (como saber que está pronto)
- Etapas devem ser ordenadas; deps usam ids numéricos sequenciais (1, 2, ...)
- Identifique riscos/decisões abertas explicitamente

Retorne EXCLUSIVAMENTE JSON nesta forma (sem markdown, sem texto antes/depois):
{
  "titulo": "string curta descrevendo o objetivo",
  "resumo": "1-2 frases sobre a abordagem",
  "riscos": ["risco 1", "risco 2"],
  "etapas": [
    { "id": 1, "titulo": "...", "descricao": "...", "deps": [], "criterio": "..." }
  ]
}`;

function callClaude(prompt, model = "sonnet", cwd) {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt, "--model", model, "--permission-mode", "bypassPermissions"];
    const opts = { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] };
    if (cwd && fs.existsSync(cwd)) opts.cwd = cwd;
    const proc = spawn("claude", args, opts);
    let out = ""; let err = "";
    proc.stdout.on("data", (c) => out += c.toString());
    proc.stderr.on("data", (c) => err += c.toString());
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
      resolve(out.trim());
    });
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("plan timeout")); }, 180000);
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

function planToMarkdown(plan) {
  const fm = [
    "---",
    `titulo: ${JSON.stringify(plan.titulo || "Plano")}`,
    `goal: ${JSON.stringify(plan.goal || "")}`,
    `projeto: ${JSON.stringify(plan.projeto || "")}`,
    `criado: ${plan.criado || dateOnly(Date.now())}`,
    `atualizado: ${new Date().toISOString()}`,
    `status: ${plan.status || "in-progress"}`,
    "tags: [plano, ultra-plan]",
    "---",
    "",
  ].join("\n");

  const lines = [`# ${plan.titulo || "Plano"}`, ""];
  if (plan.goal) lines.push(`**Goal:** ${plan.goal}`, "");
  if (plan.resumo) lines.push(plan.resumo, "");
  if (Array.isArray(plan.riscos) && plan.riscos.length) {
    lines.push("## Riscos");
    for (const r of plan.riscos) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push("## Etapas", "");
  for (const e of (plan.etapas || [])) {
    const status = e.status || "pending";
    const sym = { pending: "⬜", "in-progress": "🟡", done: "✅", blocked: "🔴", skipped: "⏭️" }[status] || "⬜";
    const deps = Array.isArray(e.deps) && e.deps.length ? ` _(deps: ${e.deps.join(", ")})_` : "";
    lines.push(`### ${sym} ${e.id}. ${e.titulo}${deps}`);
    if (e.descricao) lines.push(e.descricao);
    if (e.criterio) lines.push(`_Critério: ${e.criterio}_`);
    if (e.notas) lines.push(`> ${e.notas.replace(/\n/g, "\n> ")}`);
    lines.push("");
  }
  return fm + lines.join("\n");
}

function markdownToPlan(content, slug) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;
  const fmText = fmMatch[1];
  const body = fmMatch[2];
  const fm = {};
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') || v.startsWith("[")) {
      try { v = JSON.parse(v); } catch {}
    }
    fm[m[1]] = v;
  }
  const etapas = [];
  const etapaRegex = /^###\s+(\S+)\s+(\d+)\.\s+(.+?)(?:\s+_\(deps:\s*([^)]+)\)_)?$/gm;
  let etMatch;
  while ((etMatch = etapaRegex.exec(body))) {
    const sym = etMatch[1];
    const status = sym === "✅" ? "done" : sym === "🟡" ? "in-progress" : sym === "🔴" ? "blocked" : sym === "⏭️" ? "skipped" : "pending";
    const id = parseInt(etMatch[2], 10);
    const titulo = etMatch[3].trim();
    const deps = etMatch[4] ? etMatch[4].split(",").map(s => parseInt(s.trim(), 10)).filter(Boolean) : [];
    etapas.push({ id, titulo, status, deps });
  }
  return {
    slug,
    titulo: fm.titulo || "",
    goal: fm.goal || "",
    projeto: fm.projeto || "",
    criado: fm.criado || "",
    atualizado: fm.atualizado || "",
    status: fm.status || "in-progress",
    etapas,
  };
}

async function generatePlan({ goal, projectPath, model = "sonnet" }) {
  if (!goal || !goal.trim()) throw new Error("goal obrigatório");
  let context = "";
  if (projectPath && fs.existsSync(projectPath)) {
    const metaPath = path.join(projectPath, ".jarvis-project.json");
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        context = "\n\nCONTEXTO DO PROJETO:\n";
        if (meta.name) context += "- Nome: " + meta.name + "\n";
        if (meta.kind) context += "- Tipo: " + meta.kind + "\n";
        if (Array.isArray(meta.stack)) context += "- Stack: " + meta.stack.join(", ") + "\n";
        if (meta.description) context += "- Descrição: " + meta.description + "\n";
      } catch {}
    }
  }
  const prompt = `${PLAN_PROMPT}${context}\n\n---\nGOAL:\n${goal}`;
  const raw = await callClaude(prompt, model, projectPath);
  const parsed = extractJson(raw);
  parsed.goal = goal;
  parsed.projeto = projectPath ? path.basename(projectPath) : "";
  parsed.criado = dateOnly(Date.now());
  parsed.status = "in-progress";
  for (const e of (parsed.etapas || [])) {
    if (!e.status) e.status = "pending";
  }
  return parsed;
}

function savePlan(plan) {
  if (!fs.existsSync(PLAN_DIR)) fs.mkdirSync(PLAN_DIR, { recursive: true });
  const slug = slugify(plan.titulo || plan.goal);
  const filename = `${plan.criado || dateOnly(Date.now())}-${slug}.md`;
  let target = path.join(PLAN_DIR, filename);
  let i = 1;
  while (fs.existsSync(target)) {
    target = path.join(PLAN_DIR, `${plan.criado || dateOnly(Date.now())}-${slug}-${i}.md`);
    i++;
  }
  fs.writeFileSync(target, planToMarkdown(plan), "utf8");
  fetch("http://localhost:3001/embed/reindex", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  return path.basename(target, ".md");
}

function listPlans() {
  if (!fs.existsSync(PLAN_DIR)) return [];
  const files = fs.readdirSync(PLAN_DIR).filter(f => f.endsWith(".md"));
  const out = [];
  for (const f of files) {
    try {
      const content = fs.readFileSync(path.join(PLAN_DIR, f), "utf8");
      const slug = f.replace(/\.md$/, "");
      const plan = markdownToPlan(content, slug);
      if (plan) {
        const total = plan.etapas.length;
        const done = plan.etapas.filter(e => e.status === "done").length;
        out.push({ slug, titulo: plan.titulo, goal: plan.goal, projeto: plan.projeto, status: plan.status, criado: plan.criado, atualizado: plan.atualizado, progress: { done, total } });
      }
    } catch {}
  }
  return out.sort((a, b) => (b.atualizado || "").localeCompare(a.atualizado || ""));
}

function readPlan(slug) {
  const target = path.join(PLAN_DIR, slug + ".md");
  if (!fs.existsSync(target)) return null;
  const content = fs.readFileSync(target, "utf8");
  return markdownToPlan(content, slug);
}

function updateStep(slug, stepId, patch) {
  const plan = readPlan(slug);
  if (!plan) throw new Error("plano não encontrado");
  const step = plan.etapas.find(e => e.id === parseInt(stepId, 10));
  if (!step) throw new Error("etapa não encontrada");
  if (patch.status) step.status = patch.status;
  if (patch.notas !== undefined) step.notas = patch.notas;
  // Auto-complete plan when all steps done
  const allDone = plan.etapas.every(e => e.status === "done" || e.status === "skipped");
  if (allDone) plan.status = "done";
  else if (plan.etapas.some(e => e.status === "blocked")) plan.status = "blocked";
  else plan.status = "in-progress";
  plan.atualizado = new Date().toISOString();
  const target = path.join(PLAN_DIR, slug + ".md");
  fs.writeFileSync(target, planToMarkdown(plan), "utf8");
  fetch("http://localhost:3001/embed/reindex", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  return plan;
}

function nextRunnableStep(plan) {
  if (!plan || !Array.isArray(plan.etapas)) return null;
  const byId = new Map(plan.etapas.map(e => [e.id, e]));
  for (const e of plan.etapas) {
    if (e.status !== "pending") continue;
    const deps = Array.isArray(e.deps) ? e.deps : [];
    const depsOk = deps.every(id => {
      const dep = byId.get(id);
      return dep && (dep.status === "done" || dep.status === "skipped");
    });
    if (depsOk) return e;
  }
  return null;
}

function deletePlan(slug) {
  const target = path.join(PLAN_DIR, slug + ".md");
  if (!fs.existsSync(target)) return false;
  fs.unlinkSync(target);
  fetch("http://localhost:3001/embed/reindex", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  return true;
}

module.exports = { generatePlan, savePlan, listPlans, readPlan, updateStep, deletePlan, nextRunnableStep, PLAN_DIR };
