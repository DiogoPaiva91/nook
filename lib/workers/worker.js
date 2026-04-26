const db = require("../db");
const bus = require("./bus");
const claudeProvider = require("./providers/claude");
const ollamaProvider = require("./providers/ollama");
const { enrichHistoryForClaude, enrichHistoryForOllama } = require("./attachments");

const PROVIDERS = { claude: claudeProvider, ollama: ollamaProvider };

function safeParse(s) { try { return JSON.parse(s); } catch { return undefined; } }

class Worker {
  constructor(row) {
    this.id = row.id;
    this.title = row.title;
    this.agentId = row.agent_id;
    this.provider = row.provider;
    this.model = row.model;
    this.systemPrompt = row.system_prompt;
    this.status = row.status;
    this.lastEvent = row.last_event;
    this.kind = row.kind || "worker";
    this.createdAt = row.created_at;
    this.updatedAt = row.updated_at;
    this.activeAgent = null;
    this._abortController = null;
    this.streamingText = "";
    this.streamingThinking = "";
    this.streamingTools = [];
  }

  toJSON() {
    const data = {
      id: this.id,
      title: this.title,
      agentId: this.agentId,
      provider: this.provider,
      model: this.model,
      systemPrompt: this.systemPrompt,
      status: this.status,
      lastEvent: this.lastEvent,
      kind: this.kind,
      activeAgent: this.activeAgent,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    if (this.status === "running") {
      data.streaming = {
        text: this.streamingText,
        thinking: this.streamingThinking,
        tools: this.streamingTools.slice(),
      };
    }
    return data;
  }

  _resetStreaming() {
    this.streamingText = "";
    this.streamingThinking = "";
    this.streamingTools = [];
  }

  _setStatus(status, extra) {
    this.status = status;
    this.updatedAt = Date.now();
    db.prepare("UPDATE workers SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, this.updatedAt, this.id);
    bus.emitEvent(this.id, "status", { status, ...extra });
  }

  _setActiveAgent(agent) {
    const prev = this.activeAgent;
    this.activeAgent = agent || null;
    if (prev !== this.activeAgent) {
      bus.emitEvent(this.id, "agent-change", { from: prev, to: this.activeAgent });
    }
  }

  getHistory() {
    const rows = db.prepare(
      "SELECT id, role, content, metadata, created_at AS createdAt FROM messages WHERE worker_id = ? ORDER BY created_at ASC, id ASC"
    ).all(this.id);
    return rows.map((r) => ({
      id: r.id,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt,
      metadata: r.metadata ? safeParse(r.metadata) : undefined,
    }));
  }

  appendMessage(role, content, metadata) {
    const createdAt = Date.now();
    const metaStr = metadata ? JSON.stringify(metadata) : null;
    const info = db.prepare(
      "INSERT INTO messages (worker_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(this.id, role, content, metaStr, createdAt);
    db.prepare("UPDATE workers SET updated_at = ? WHERE id = ?").run(createdAt, this.id);
    this.updatedAt = createdAt;
    const msg = { id: info.lastInsertRowid, role, content, createdAt, metadata };
    bus.emitEvent(this.id, "message", msg);
    return msg;
  }

  abort() {
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
  }

  _filterHistory(history, mode, limit) {
    if (mode === "none") return history.slice(-1);
    if (mode === "limited") {
      const n = typeof limit === "number" && limit > 0 ? limit : 6;
      return history.slice(-n);
    }
    return history;
  }

  async sendMessage(userContent, options = {}) {
    if (this.status === "running") {
      throw new Error("Worker já está processando uma mensagem");
    }
    const provider = PROVIDERS[this.provider];
    if (!provider) throw new Error("Provider desconhecido: " + this.provider);

    const {
      bmadAgent = null,
      attachments = null,
      systemPromptOverride = null,
      historyMode = "full",
      historyLimit = 6,
      temperature,
    } = options;

    const userMeta = {};
    if (attachments && attachments.length) userMeta.attachments = attachments;
    this.appendMessage("user", userContent, Object.keys(userMeta).length ? userMeta : null);

    if (bmadAgent) this._setActiveAgent(bmadAgent);
    this._resetStreaming();
    this._setStatus("running");

    const rawHistory = this.getHistory();
    const enrich = this.provider === "claude" ? enrichHistoryForClaude : enrichHistoryForOllama;
    let history = enrich(rawHistory.map((m) => ({
      role: m.role,
      content: m.content,
      metadata: m.metadata,
    })));
    history = this._filterHistory(history, historyMode, historyLimit);

    const effectiveSystem = systemPromptOverride != null ? systemPromptOverride : this.systemPrompt;
    this._abortController = new AbortController();

    const onEvent = (kind, payload) => {
      if (kind === "token" && payload && typeof payload.text === "string") {
        this.streamingText += payload.text;
      } else if (kind === "thinking" && payload && typeof payload.text === "string") {
        this.streamingThinking += payload.text;
      } else if (kind === "tool" && payload) {
        this.streamingTools.push({
          id: payload.id,
          name: payload.name,
          input: payload.input || {},
          status: "running",
        });
      } else if (kind === "tool_result" && payload) {
        const t = this.streamingTools.find((x) => x.id === payload.id);
        if (t) {
          t.status = payload.ok ? "done" : "error";
          t.summary = payload.summary;
        }
      }
      bus.emitEvent(this.id, kind, payload);
    };

    let result;
    try {
      result = await provider.run({
        model: this.model,
        systemPrompt: effectiveSystem,
        history,
        onEvent,
        signal: this._abortController.signal,
        temperature,
      });
    } catch (err) {
      bus.emitEvent(this.id, "error", { message: err.message });
      this._setStatus("error", { message: err.message });
      this._abortController = null;
      this._resetStreaming();
      return;
    }

    this._abortController = null;

    if (result.text) {
      const asstMeta = {};
      if (bmadAgent) asstMeta.bmadAgent = bmadAgent;
      this.appendMessage("assistant", result.text, Object.keys(asstMeta).length ? asstMeta : null);
    }

    this._resetStreaming();

    if (result.error) {
      this._setStatus("error", { message: result.error });
    } else {
      this._setStatus("idle");
      bus.emitEvent(this.id, "done", { usage: result.usage || null });
    }
  }
}

module.exports = Worker;
