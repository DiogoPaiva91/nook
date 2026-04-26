const crypto = require("crypto");
const db = require("../db");
const Worker = require("./worker");

const cache = new Map();

function _hydrate(row) {
  if (!row) return null;
  if (cache.has(row.id)) {
    const w = cache.get(row.id);
    w.status = row.status;
    w.title = row.title;
    w.updatedAt = row.updated_at;
    return w;
  }
  const w = new Worker(row);
  cache.set(w.id, w);
  return w;
}

function create({ title, agentId, provider, model, systemPrompt, kind }) {
  if (!provider) throw new Error("provider é obrigatório");
  const id = "w_" + crypto.randomBytes(6).toString("hex");
  const now = Date.now();
  db.prepare(`
    INSERT INTO workers (id, title, agent_id, provider, model, system_prompt, status, kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?)
  `).run(id, title || null, agentId || null, provider, model || null, systemPrompt || null, kind || "worker", now, now);
  const row = db.prepare("SELECT * FROM workers WHERE id = ?").get(id);
  return _hydrate(row);
}

function get(id) {
  const row = db.prepare("SELECT * FROM workers WHERE id = ?").get(id);
  return _hydrate(row);
}

function list({ kind } = {}) {
  const rows = kind
    ? db.prepare("SELECT * FROM workers WHERE kind = ? ORDER BY updated_at DESC").all(kind)
    : db.prepare("SELECT * FROM workers ORDER BY updated_at DESC").all();
  return rows.map(_hydrate);
}

function remove(id) {
  const w = get(id);
  if (w) w.abort();
  cache.delete(id);
  const info = db.prepare("DELETE FROM workers WHERE id = ?").run(id);
  return info.changes > 0;
}

function update(id, patch) {
  const fields = [];
  const vals = [];
  for (const key of ["title", "model", "system_prompt", "agent_id"]) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (patch[camel] !== undefined) {
      fields.push(`${key} = ?`);
      vals.push(patch[camel]);
    }
  }
  if (!fields.length) return get(id);
  fields.push("updated_at = ?");
  vals.push(Date.now(), id);
  db.prepare(`UPDATE workers SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
  cache.delete(id);
  return get(id);
}

module.exports = { create, get, list, remove, update };
