const http = require("http");

const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";

function run({ model, systemPrompt, history, onEvent, signal, temperature }) {
  return new Promise((resolve) => {
    const msgs = [];
    if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
    for (const m of history) {
      const entry = { role: m.role, content: m.content };
      if (Array.isArray(m.images) && m.images.length) entry.images = m.images;
      msgs.push(entry);
    }

    const body = { model, messages: msgs, stream: true };
    if (typeof temperature === "number") body.options = { temperature };

    const payload = JSON.stringify(body);
    const url = new URL(OLLAMA + "/api/chat");

    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 300000,
    }, (ollamaRes) => {
      let finalText = "";
      let usage = null;
      let inThink = false;

      ollamaRes.on("data", (chunk) => {
        const lines = chunk.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          let parsed;
          try { parsed = JSON.parse(line); } catch { continue; }
          let token = parsed.message?.content || "";
          if (token) {
            while (token.length > 0) {
              if (!inThink) {
                const openIdx = token.indexOf("<think>");
                if (openIdx === -1) {
                  finalText += token;
                  onEvent("token", { text: token });
                  break;
                }
                if (openIdx > 0) {
                  const slice = token.slice(0, openIdx);
                  finalText += slice;
                  onEvent("token", { text: slice });
                }
                token = token.slice(openIdx + 7);
                inThink = true;
              }
              if (inThink) {
                const closeIdx = token.indexOf("</think>");
                if (closeIdx === -1) {
                  if (token) onEvent("thinking", { text: token });
                  break;
                }
                if (closeIdx > 0) onEvent("thinking", { text: token.slice(0, closeIdx) });
                token = token.slice(closeIdx + 8);
                inThink = false;
              }
            }
          }
          if (parsed.done) {
            if (parsed.prompt_eval_count || parsed.eval_count) {
              usage = {
                input: parsed.prompt_eval_count || 0,
                output: parsed.eval_count || 0,
                cacheRead: 0, cacheCreate: 0,
                model, provider: "ollama",
              };
              onEvent("usage", usage);
            }
          }
        }
      });

      ollamaRes.on("end", () => resolve({ text: finalText, usage }));
      ollamaRes.on("error", (err) => {
        onEvent("error", { message: err.message });
        resolve({ text: finalText, usage, error: err.message });
      });
    });

    req.on("error", (err) => {
      const msg = "Ollama offline. Rode: ollama serve";
      onEvent("error", { message: msg });
      resolve({ text: "", usage: null, error: msg });
    });

    if (signal) {
      signal.addEventListener("abort", () => { try { req.destroy(); } catch {} }, { once: true });
    }

    req.write(payload);
    req.end();
  });
}

module.exports = { run };
