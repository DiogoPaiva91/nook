const db = require("../db");
const registry = require("../workers/registry");

function listChats() {
  return registry.list({ kind: "chat" }).map((w) => w.toJSON());
}

function createChat({ title, assistantId, provider, model, systemPrompt }) {
  const w = registry.create({
    title: title || "Nova conversa",
    agentId: assistantId || null,
    provider: provider || "ollama",
    model: model || null,
    systemPrompt: systemPrompt || null,
    kind: "chat",
  });
  return w.toJSON();
}

function getChat(id) {
  const w = registry.get(id);
  if (!w || w.kind !== "chat") return null;
  return w.toJSON();
}

function renameChat(id, title) {
  const w = registry.get(id);
  if (!w || w.kind !== "chat") return null;
  registry.update(id, { title });
  return registry.get(id).toJSON();
}

function updateChatModel(id, { provider, model, systemPrompt, assistantId }) {
  const w = registry.get(id);
  if (!w || w.kind !== "chat") return null;
  const now = Date.now();
  const fields = [];
  const vals = [];
  if (provider !== undefined) { fields.push("provider = ?"); vals.push(provider); }
  if (model !== undefined) { fields.push("model = ?"); vals.push(model); }
  if (systemPrompt !== undefined) { fields.push("system_prompt = ?"); vals.push(systemPrompt); }
  if (assistantId !== undefined) { fields.push("agent_id = ?"); vals.push(assistantId); }
  if (!fields.length) return getChat(id);
  fields.push("updated_at = ?");
  vals.push(now, id);
  db.prepare(`UPDATE workers SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  return getChat(id);
}

function deleteChat(id) {
  const w = registry.get(id);
  if (!w || w.kind !== "chat") return false;
  return registry.remove(id);
}

function getMessages(id) {
  const w = registry.get(id);
  if (!w || w.kind !== "chat") return null;
  return w.getHistory();
}

function appendMessage(id, { role, content, metadata }) {
  const w = registry.get(id);
  if (!w || w.kind !== "chat") return null;
  return w.appendMessage(role, content, metadata);
}

function replaceMessages(id, messages) {
  const w = registry.get(id);
  if (!w || w.kind !== "chat") return null;
  const tx = db.transaction((msgs) => {
    db.prepare("DELETE FROM messages WHERE worker_id = ?").run(id);
    const stmt = db.prepare(
      "INSERT INTO messages (worker_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    let t = Date.now() - msgs.length;
    for (const m of msgs) {
      const meta = m.metadata ? JSON.stringify(m.metadata) : null;
      stmt.run(id, m.role, m.content || "", meta, m.createdAt || t++);
    }
    db.prepare("UPDATE workers SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  });
  tx(messages);
  return getMessages(id);
}

function migrateFromLocalStorage(payload) {
  const { conversations = {}, assistants = {}, activeId = null } = payload || {};
  const created = {};
  const tx = db.transaction(() => {
    for (const [oldId, conv] of Object.entries(conversations)) {
      const asst = conv.assistantId === "jarvis"
        ? { provider: "claude", model: "opus", systemPrompt: "" }
        : (assistants[conv.assistantId] || { provider: "ollama", model: null, systemPrompt: "" });
      const chat = createChat({
        title: conv.title || "Nova conversa",
        assistantId: conv.assistantId || null,
        provider: asst.provider || "ollama",
        model: asst.model || null,
        systemPrompt: asst.systemPrompt || "",
      });
      if (conv.createdAt) {
        db.prepare("UPDATE workers SET created_at = ?, updated_at = ? WHERE id = ?")
          .run(conv.createdAt, conv.updatedAt || conv.createdAt, chat.id);
      }
      if (Array.isArray(conv.messages) && conv.messages.length) {
        const stmt = db.prepare(
          "INSERT INTO messages (worker_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
        );
        const base = conv.createdAt || Date.now() - conv.messages.length;
        conv.messages.forEach((m, idx) => {
          const meta = {};
          if (m.attachments) meta.attachments = m.attachments;
          if (m.thinking) meta.thinking = m.thinking;
          if (m.thinkingDuration) meta.thinkingDuration = m.thinkingDuration;
          if (m.steps) meta.steps = m.steps;
          if (m.bmadAgent) meta.bmadAgent = m.bmadAgent;
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : null;
          stmt.run(chat.id, m.role, m.content || "", metaStr, base + idx);
        });
      }
      created[oldId] = chat.id;
    }
  });
  tx();
  return { created, activeIdMapped: activeId ? created[activeId] || null : null };
}

module.exports = {
  listChats,
  createChat,
  getChat,
  renameChat,
  updateChatModel,
  deleteChat,
  getMessages,
  appendMessage,
  replaceMessages,
  migrateFromLocalStorage,
};
