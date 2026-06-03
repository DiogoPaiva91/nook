const http = require("http");
const fs = require("fs");
const { EXTRA_DIRS, buildSystem } = require("./_preamble");

// Provider interativo: roda o chat via sidecar Python (claude-agent-sdk) com
// gating real de permissão (PreToolUse hook). Emite os mesmos eventos do provider
// CLI via onEvent, mais `permission_request` (decidido pela rota /api/workers/:id/permission).
function run({ model, systemPrompt, history, onEvent, signal, cwd, permissionMode, effort, sessionId }) {
  return new Promise((resolve) => {
    const finalSystem = buildSystem(systemPrompt, cwd);
    const addDirs = EXTRA_DIRS.filter((d) => { try { return fs.existsSync(d); } catch { return false; } });
    const payload = JSON.stringify({
      sessionId: sessionId || "sess",
      system: finalSystem,
      history: (history || []).map((m) => ({ role: m.role, content: m.content })),
      model: model || undefined,
      cwd: cwd || undefined,
      addDirs,
      effort: effort || undefined,
      permissionMode: permissionMode || "default",
    });

    const req = http.request({
      host: "127.0.0.1", port: 3001, path: "/sdk/chat", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let buf = "";
      let finalText = "";
      let usage = null;
      const toolMap = {};

      res.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith("data:")) continue;
          let evt;
          try { evt = JSON.parse(l.slice(5).trim()); } catch { continue; }
          const k = evt.kind;
          if (k === "thinking") onEvent("thinking", { text: evt.text });
          else if (k === "token") { finalText += evt.text || ""; onEvent("token", { text: evt.text }); }
          else if (k === "tool") { toolMap[evt.id] = evt.name; onEvent("tool", { id: evt.id, name: evt.name, input: evt.input || {} }); }
          else if (k === "tool_result") onEvent("tool_result", { id: evt.id, name: toolMap[evt.id] || evt.name || "tool", ok: evt.ok !== false, summary: evt.summary || "" });
          else if (k === "permission_request") onEvent("permission_request", { permId: evt.permId, name: evt.name, input: evt.input || {} });
          else if (k === "rate_limit") onEvent("rate_limit", evt);
          else if (k === "usage") {
            const inp = evt.input || 0, out = evt.output || 0;
            const cr = evt.cacheRead || 0, cw = evt.cacheCreate || 0;
            const realModel = evt.model || model || "sonnet";
            const pm = realModel.includes("opus") ? { i: 15, o: 75, cr: 1.5, cw: 18.75 }
              : realModel.includes("haiku") ? { i: 0.8, o: 4, cr: 0.08, cw: 1 }
              : { i: 3, o: 15, cr: 0.3, cw: 3.75 };
            const cost = (inp * pm.i + out * pm.o + cr * pm.cr + cw * pm.cw) / 1e6;
            usage = {
              input: inp, output: out, cacheRead: cr, cacheCreate: cw,
              cost, totalCostUsd: evt.totalCostUsd != null ? evt.totalCostUsd : cost,
              model: realModel, provider: "claude",
            };
            onEvent("usage", usage);
          }
          else if (k === "error") onEvent("error", { message: evt.message });
        }
      });
      res.on("end", () => resolve({ text: finalText, usage }));
      res.on("error", (e) => { onEvent("error", { message: e.message }); resolve({ text: finalText, usage, error: e.message }); });
    });

    req.on("error", (e) => {
      const msg = "sidecar :3001 indisponível (" + e.message + "). O chat interativo precisa do core de pé.";
      onEvent("error", { message: msg });
      resolve({ text: "", error: msg });
    });

    if (signal) signal.addEventListener("abort", () => { try { req.destroy(); } catch {} }, { once: true });

    req.write(payload);
    req.end();
  });
}

module.exports = { run };
