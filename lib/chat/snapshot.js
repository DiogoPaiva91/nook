const fs = require("fs");
const path = require("path");

const HUB_ROOT = process.env.HUB_ROOT || "/home/diogo/dev/_hub";
const SNAP_DIR = path.join(HUB_ROOT, "conversas");
const DEBOUNCE_MS = 5000;
const MIN_MESSAGES = 2;
const DISTILL_EVERY = parseInt(process.env.JARVIS_DISTILL_EVERY || "30", 10);

const timers = new Map();
const filenames = new Map();
const distilledAt = new Map(); // workerId -> last msg count distilled

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "conversa";
}

function dateOnly(ts) {
  const d = new Date(ts || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shortId(id) {
  return String(id || "").replace(/^w_/, "").slice(0, 8) || "conv";
}

function targetPath(chat) {
  const slug = slugify(chat.title || "nova-conversa");
  return path.join(SNAP_DIR, `${dateOnly(chat.createdAt)}-${slug}--${shortId(chat.id)}.md`);
}

function frontmatter(chat, msgCount) {
  const tags = ["conversa"];
  let projectName = "";
  if (chat.kind && chat.kind !== "chat") {
    const slug = chat.kind.replace(/[^a-z0-9]+/g, "-");
    tags.push(slug);
    // For "code:<projectName>" kinds, also emit a stable "code-<projectName>"
    // tag preserving the original (so RAG can match by raw activeProj).
    if (typeof chat.kind === "string" && chat.kind.startsWith("code:")) {
      projectName = chat.kind.slice(5);
      const rawTag = "code-" + projectName;
      if (!tags.includes(rawTag)) tags.push(rawTag);
    }
  }
  const lines = [
    "---",
    `titulo: ${JSON.stringify(chat.title || "Nova conversa")}`,
    `data: ${dateOnly(chat.createdAt)}`,
    `atualizado: ${new Date().toISOString()}`,
    `fonte: jarvis-chat`,
    `conversa_id: ${chat.id}`,
    `provider: ${chat.provider || ""}`,
    `model: ${chat.model || ""}`,
    `mensagens: ${msgCount}`,
  ];
  if (projectName) lines.push(`projeto: ${projectName}`);
  lines.push(`tags: [${tags.join(", ")}]`);
  lines.push("---", "");
  return lines.join("\n");
}

function renderMessage(m) {
  const ts = new Date(m.createdAt || Date.now()).toISOString();
  const role = m.role === "user" ? "Usuário" : (m.role === "assistant" ? "Assistente" : m.role);
  const head = `## ${role} — ${ts}`;
  const body = (m.content || "").trim();
  return `${head}\n\n${body}\n`;
}

function writeSnapshot(workerId) {
  const registry = require("../workers/registry");
  const chatStore = require("./conversations");
  // Try chatStore first (for chat/code conversations); fall back to registry for cowork workers
  let chat = chatStore.getChat(workerId);
  if (!chat) {
    const w = registry.get(workerId);
    if (!w) return;
    chat = w.toJSON();
  }
  let msgs = chatStore.getMessages(workerId);
  if (!msgs) {
    const w = registry.get(workerId);
    msgs = w ? w.getHistory() : [];
  }
  if (!msgs || msgs.length < MIN_MESSAGES) return;

  if (!fs.existsSync(SNAP_DIR)) fs.mkdirSync(SNAP_DIR, { recursive: true });

  const target = targetPath(chat);
  const previous = filenames.get(workerId);
  if (previous && previous !== target && fs.existsSync(previous)) {
    try { fs.unlinkSync(previous); } catch {}
  }
  filenames.set(workerId, target);

  const out = frontmatter(chat, msgs.length) + msgs.map(renderMessage).join("\n");
  const tmp = target + ".tmp";
  try {
    fs.writeFileSync(tmp, out, "utf8");
    fs.renameSync(tmp, target);
    // Fire-and-forget: rebuild embeddings index so this conversation is searchable
    fetch("http://localhost:3001/embed/reindex", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});
    maybeAutoDistill(workerId, msgs.length);
  } catch (e) {
    console.error("[snapshot] erro:", e.message);
  }
}

function maybeAutoDistill(workerId, msgCount) {
  if (msgCount < DISTILL_EVERY) return;
  const last = distilledAt.get(workerId) || 0;
  // Distill at every DISTILL_EVERY-message threshold
  const nextThreshold = Math.floor(msgCount / DISTILL_EVERY) * DISTILL_EVERY;
  if (nextThreshold <= last) return;
  distilledAt.set(workerId, nextThreshold);
  // Fire-and-forget — don't block the snapshot path
  setImmediate(async () => {
    try {
      const distill = require("./distill");
      const r = await distill.distillConversation(workerId);
      if (r.written) console.log(`[distill auto] ${workerId} → ${r.path} (${r.fatos} fatos)`);
    } catch (e) {
      console.error(`[distill auto] ${workerId} falhou:`, e.message);
      distilledAt.set(workerId, last); // unmark so next snapshot retries
    }
  });
}

function scheduleSnapshot(workerId) {
  if (!workerId) return;
  const existing = timers.get(workerId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    timers.delete(workerId);
    try { writeSnapshot(workerId); } catch (e) { console.error("[snapshot] flush:", e.message); }
  }, DEBOUNCE_MS);
  if (typeof t.unref === "function") t.unref();
  timers.set(workerId, t);
}

function flushNow(workerId) {
  const t = timers.get(workerId);
  if (t) { clearTimeout(t); timers.delete(workerId); }
  writeSnapshot(workerId);
}

module.exports = { scheduleSnapshot, flushNow, targetPath, HUB_ROOT, SNAP_DIR };
