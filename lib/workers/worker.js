const db = require("../db");
const bus = require("./bus");
const claudeProvider = require("./providers/claude");
const claudeSdkProvider = require("./providers/claude_sdk");
const ollamaProvider = require("./providers/ollama");
const { enrichHistoryForClaude, enrichHistoryForOllama } = require("./attachments");
const snapshot = require("../chat/snapshot");
const hubContext = require("../hub/context");

const CHATLIKE = (k) => k === "chat" || k === "code" || k === "worker" || (typeof k === "string" && k.startsWith("code:"));

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
    this.cwd = row.cwd || null;
    this.createdAt = row.created_at;
    this.updatedAt = row.updated_at;
    this.activeAgent = null;
    this._abortController = null;
    this.streamingText = "";
    this.streamingThinking = "";
    this.streamingTools = [];
    this.pendingMessages = [];
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
      cwd: this.cwd,
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
    if (CHATLIKE(this.kind)) snapshot.scheduleSnapshot(this.id);
    return msg;
  }

  abort() {
    this._userAborted = true;
    this.pendingMessages = [];
    if (this._abortController) {
      try { this._abortController.abort(); } catch {}
    }
    bus.emitEvent(this.id, "aborted", { at: Date.now() });
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
    let provider = PROVIDERS[this.provider];
    if (!provider) throw new Error("Provider desconhecido: " + this.provider);

    if (!options._skipAppend) this._userAborted = false;

    if (this.status === "running") {
      const userMeta = {};
      if (options.attachments && options.attachments.length) userMeta.attachments = options.attachments;
      userMeta.queued = true;
      if (options.interrupt) userMeta.interrupt = true;
      this.appendMessage("user", userContent, userMeta);
      this.pendingMessages.push({ userContent, options: { ...options, _skipAppend: true } });
      bus.emitEvent(this.id, "queued", {
        interrupt: !!options.interrupt,
        pending: this.pendingMessages.length,
      });
      if (options.interrupt) this.abort();
      return { queued: true };
    }

    const {
      bmadAgent = null,
      attachments = null,
      systemPromptOverride = null,
      historyMode = "full",
      historyLimit = 6,
      temperature,
      permissionMode = null,
      effort = null,
      _skipAppend = false,
    } = options;

    // Chat interativo: quando o composer pede gating (default/acceptEdits), roda via
    // sidecar SDK (permissão real por PreToolUse hook). Workers autônomos seguem no CLI.
    if (this.provider === "claude" && (permissionMode === "default" || permissionMode === "acceptEdits")) {
      provider = claudeSdkProvider;
    }

    if (!_skipAppend) {
      const userMeta = {};
      if (attachments && attachments.length) userMeta.attachments = attachments;
      this.appendMessage("user", userContent, Object.keys(userMeta).length ? userMeta : null);
    }

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

    let effectiveSystem = systemPromptOverride != null ? systemPromptOverride : this.systemPrompt;
    try {
      const ctx = await hubContext.findContext(userContent, 3, this.kind);
      if (ctx.notes.length) {
        const preamble = hubContext.buildPreamble(ctx.notes);
        effectiveSystem = preamble + (effectiveSystem || "");
        bus.emitEvent(this.id, "context", { source: ctx.source, notes: ctx.notes.map(n => ({ path: n.path, score: Math.round((n.score || 0) * 1000) / 1000 })) });
      }
    } catch {}
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

    const TIMEOUT_MS = parseInt(process.env.JARVIS_WORKER_TIMEOUT_MS || "600000", 10); // 10 min
    const MAX_RETRIES = 1;
    let result;
    let attempt = 0;
    let lastErr = null;
    let runHistory = history;
    while (attempt <= MAX_RETRIES) {
      const timer = setTimeout(() => {
        try { this._abortController && this._abortController.abort(); } catch {}
        bus.emitEvent(this.id, "timeout", { afterMs: TIMEOUT_MS });
      }, TIMEOUT_MS);
      try {
        result = await provider.run({
          model: this.model,
          systemPrompt: effectiveSystem,
          history: runHistory,
          onEvent,
          signal: this._abortController.signal,
          temperature,
          cwd: this.cwd,
          permissionMode,
          effort,
          sessionId: this.id,
        });
        clearTimeout(timer);
      } catch (err) {
        clearTimeout(timer);
        lastErr = err;
        result = { text: "", error: err.message };
      }
      const transportError = !result.text && result.error && !this._abortController.signal.aborted;
      if (transportError && attempt < MAX_RETRIES) {
        attempt++;
        bus.emitEvent(this.id, "retry", { attempt, reason: result.error });
        runHistory = runHistory.concat([{
          role: "user",
          content: `[Tentativa anterior falhou: ${(result.error || "erro").slice(0, 200)}]\nTente de novo, com cuidado.`,
        }]);
        this._abortController = new AbortController();
        continue;
      }
      break;
    }

    this._abortController = null;

    if (result && result.text) {
      const asstMeta = {};
      if (bmadAgent) asstMeta.bmadAgent = bmadAgent;
      if (this.streamingThinking) asstMeta.thinking = this.streamingThinking;
      if (this.streamingTools && this.streamingTools.length) {
        asstMeta.steps = this.streamingTools.map((t) => ({
          tool: t.name,
          input: t.input || {},
          status: t.status === "error" ? "error" : "ok",
          summary: t.summary,
        }));
      }
      this.appendMessage("assistant", result.text, Object.keys(asstMeta).length ? asstMeta : null);
    }

    const isCautious = this.systemPrompt && /AGENTE DE AUTOMAÇÃO/i.test(this.systemPrompt);
    if (this.kind === "worker" && result && result.text && this.pendingMessages.length === 0 && !this._userAborted && !isCautious) {
      const failureRe = /(?:de(?:u|i) erro|n[ãa]o consegui|n[ãa]o foi poss[ií]vel|falhou|falha ao|n[ãa]o funcionou|n[ãa]o consigo|imposs[ií]vel resolver|sem sucesso|desisti|n[ãa]o sei como)/i;
      const successRe = /(?:consegui|funcionou|conclu[ií]d|tarefa pronta|feito\b|sucesso|tudo certo)/i;
      const MAX_IMPROVE = 2;
      let improveAttempts = 0;
      while (improveAttempts < MAX_IMPROVE) {
        if (this.pendingMessages.length > 0) break;
        const text = result.text || "";
        const tail = text.slice(-2500);
        const hadFailure = failureRe.test(tail);
        const hadSuccess = successRe.test(tail);
        const toolErrors = (this.streamingTools || []).filter(t => t.status === "error").length;
        if (!hadFailure) break;
        if (hadSuccess && toolErrors === 0) break;

        improveAttempts++;
        bus.emitEvent(this.id, "auto-improve", { attempt: improveAttempts, toolErrors });

        const followup = "Você reportou erro/falha, mas a tarefa não foi concluída. Aplique a AUTONOMIA agora: "
          + "1) DIAGNOSTICAR a causa-raiz (curl localhost:3001/diagnostics, tail dos logs em /tmp/jarvis-*.log, ler o código relevante); "
          + "2) HIPOTETIZAR a causa em uma frase; "
          + "3) CORRIGIR aplicando uma abordagem DIFERENTE da que falhou (não repita o mesmo comando/edit); "
          + "4) RE-TENTAR a operação original. "
          + "Não me responda 'falhou de novo' sem ter tentado uma abordagem totalmente diferente.";
        this.appendMessage("user", followup, { autoImprove: true, attempt: improveAttempts });

        const fresh2 = this.getHistory();
        let newHistory = enrich(fresh2.map((m) => ({ role: m.role, content: m.content, metadata: m.metadata })));
        newHistory = this._filterHistory(newHistory, historyMode, historyLimit);

        this._resetStreaming();
        this._abortController = new AbortController();
        const timer2 = setTimeout(() => {
          try { this._abortController && this._abortController.abort(); } catch {}
          bus.emitEvent(this.id, "timeout", { afterMs: TIMEOUT_MS });
        }, TIMEOUT_MS);
        try {
          result = await provider.run({
            model: this.model,
            systemPrompt: effectiveSystem,
            history: newHistory,
            onEvent,
            signal: this._abortController.signal,
            temperature,
            cwd: this.cwd,
            permissionMode,
            effort,
            sessionId: this.id,
          });
          clearTimeout(timer2);
        } catch (err) {
          clearTimeout(timer2);
          result = { text: "", error: err.message };
        }
        this._abortController = null;

        if (result && result.text) {
          this.appendMessage("assistant", result.text, null);
        } else {
          break;
        }
      }
    }

    this._resetStreaming();

    if (result && result.error && !result.text) {
      bus.emitEvent(this.id, "error", { message: result.error });
      this._setStatus("error", { message: result.error });
    } else {
      this._setStatus("idle");
      bus.emitEvent(this.id, "done", { usage: (result && result.usage) || null });
    }
    void lastErr;

    if (this.pendingMessages.length > 0 && this.status !== "running" && !this._userAborted) {
      const next = this.pendingMessages.shift();
      setImmediate(() => {
        this.sendMessage(next.userContent, next.options).catch((err) => {
          bus.emitEvent(this.id, "error", { message: err.message });
        });
      });
    }
  }
}

module.exports = Worker;
