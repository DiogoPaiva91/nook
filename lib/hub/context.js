const fs = require("fs");
const path = require("path");

const HUB_ROOT = "/home/diogo/dev/_hub";
const SIDECAR = "http://localhost:3001";

const STOPWORDS = new Set([
  "a","o","e","de","da","do","das","dos","em","no","na","nos","nas","para","por","com","sem",
  "que","como","qual","quais","quando","onde","quem","cuja","cujo","ser","ter","fazer","esta","este",
  "the","a","an","of","in","on","for","to","and","or","is","are","was","were","be","been","being",
]);

function tokenize(text) {
  if (!text || typeof text !== "string") return [];
  const lower = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return lower.match(/[a-z0-9]{3,}/g)?.filter(t => !STOPWORDS.has(t)) || [];
}

// Conversation snapshots carry a mode tag in frontmatter (snapshot.js). The
// RAG must not leak one mode's conversations into another's context. Returns
// "chat" | "code" | "cowork" for conversation notes, or null for curated
// knowledge (snippets/padroes/decisoes/ADRs) which is shared across all modes.
function noteMode(relPath, raw) {
  if (!/^conversas[\\/]/.test(relPath)) return null;
  const fm = (raw || "").match(/^---\n([\s\S]*?)\n---/);
  const tagLine = fm && fm[1].match(/tags:\s*\[([^\]]*)\]/);
  const tags = tagLine ? tagLine[1].split(",").map(s => s.trim()) : [];
  if (tags.includes("worker")) return "cowork";
  if (tags.some(t => t === "code" || t.startsWith("code-"))) return "code";
  return "chat";
}

function workerMode(kind) {
  if (kind === "worker") return "cowork";
  if (kind === "code" || (typeof kind === "string" && kind.startsWith("code:"))) return "code";
  return "chat";
}

async function findSemantic(query, limit) {
  limit = limit || 3;
  try {
    const url = SIDECAR + "/embed/search?q=" + encodeURIComponent(query) + "&top_k=" + limit + "&min_score=0.4";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const d = await r.json();
    if (!Array.isArray(d.results) || !d.results.length) return [];
    const out = [];
    for (const it of d.results) {
      if (!it.path) continue;
      const full = path.join(HUB_ROOT, it.path);
      let raw = "";
      try { raw = fs.readFileSync(full, "utf8"); } catch {}
      out.push({ path: it.path, content: raw.replace(/^---[\s\S]*?\n---\n+/, ""), score: it.score || 0, mode: noteMode(it.path, raw) });
    }
    return out;
  } catch { return []; }
}

function findKeyword(query, limit) {
  limit = limit || 3;
  if (!fs.existsSync(HUB_ROOT)) return [];
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const queryFreq = {};
  for (const t of queryTokens) queryFreq[t] = (queryFreq[t] || 0) + 1;
  const results = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "templates") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".md")) continue;
      try {
        const content = fs.readFileSync(full, "utf8");
        const tokens = tokenize(content);
        if (!tokens.length) continue;
        const tokenSet = new Set(tokens);
        let score = 0;
        for (const qt of Object.keys(queryFreq)) {
          if (!tokenSet.has(qt)) continue;
          const occurrences = tokens.filter(t => t === qt).length;
          score += 1 + Math.min(occurrences, 8) * 0.25 + queryFreq[qt] * 0.5;
        }
        if (score > 0) {
          const rel = path.relative(HUB_ROOT, full);
          results.push({
            path: rel,
            content: content.replace(/^---[\s\S]*?\n---\n+/, ""),
            score,
            mode: noteMode(rel, content),
          });
        }
      } catch {}
    }
  };
  walk(HUB_ROOT);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

async function findContext(query, limit, kind) {
  limit = limit || 3;
  const mode = workerMode(kind);
  // Keep curated knowledge (mode === null) for everyone; drop conversation
  // snapshots from other modes so context never crosses Chat/Code/Cowork.
  const keep = (notes) => notes.filter(n => n.mode == null || n.mode === mode).slice(0, limit);
  const semantic = keep(await findSemantic(query, limit * 4));
  if (semantic.length) return { source: "semantic", notes: semantic };
  const keyword = keep(findKeyword(query, limit * 4));
  if (keyword.length) return { source: "keyword", notes: keyword };
  return { source: "none", notes: [] };
}

function buildPreamble(notes) {
  if (!notes || !notes.length) return "";
  const ctxBlock = notes.map(n => `### ${n.path}\n${n.content.slice(0, 1500)}`).join("\n\n---\n\n");
  return "Voce tem acesso ao vault de conhecimento do usuario (notas pessoais, snippets, ADRs). Use as notas abaixo como contexto se relevante. Se nao for relevante para a pergunta, ignore.\n\n=== NOTAS DO VAULT ===\n\n" + ctxBlock + "\n\n=== FIM DAS NOTAS ===\n\n";
}

module.exports = { findContext, findSemantic, findKeyword, buildPreamble, noteMode, workerMode, HUB_ROOT };
