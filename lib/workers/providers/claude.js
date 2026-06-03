const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { EXTRA_DIRS, buildSystem } = require("./_preamble");

function run({ model, systemPrompt, history, onEvent, signal, cwd, permissionMode }) {
  return new Promise((resolve) => {
    let prompt = "";
    for (const m of history) {
      if (m.role === "user") prompt += "User: " + m.content + "\n";
      else if (m.role === "assistant") prompt += "Assistant: " + m.content + "\n";
    }

    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", (["bypassPermissions", "plan", "acceptEdits", "default"].includes(permissionMode) ? permissionMode : "bypassPermissions"),
    ];
    for (const d of EXTRA_DIRS) {
      if (fs.existsSync(d)) args.push("--add-dir", d);
    }
    if (model) args.push("--model", model);
    const finalSystem = buildSystem(systemPrompt, cwd);
    args.push("--append-system-prompt", finalSystem);

    const spawnOpts = {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    };
    if (cwd && fs.existsSync(cwd)) spawnOpts.cwd = cwd;
    const proc = spawn("claude", args, spawnOpts);

    if (signal) {
      signal.addEventListener("abort", () => {
        try { proc.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 1500);
      }, { once: true });
    }

    let lineBuf = "";
    let finalText = "";
    let usage = null;
    const toolMap = {};

    proc.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString();
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }

        if (evt.type === "assistant" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === "thinking" && block.thinking) {
              onEvent("thinking", { text: block.thinking });
            } else if (block.type === "text" && block.text) {
              finalText += block.text;
              onEvent("token", { text: block.text });
            } else if (block.type === "tool_use") {
              toolMap[block.id] = block.name;
              onEvent("tool", { id: block.id, name: block.name, input: block.input || {} });
            }
          }
        } else if (evt.type === "user" && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === "tool_result") {
              const toolName = toolMap[block.tool_use_id] || "unknown";
              let summary = "", ok = !block.is_error;
              if (typeof block.content === "string") {
                const rl = block.content.split("\n");
                summary = rl.length + " linhas";
                const lower = block.content.toLowerCase();
                if (lower.includes("permission") || lower.includes("denied") || lower.includes("not allowed")) {
                  ok = false; summary = "permissao negada";
                }
              }
              if (evt.tool_use_result?.file) summary = evt.tool_use_result.file.totalLines + " linhas";
              onEvent("tool_result", { id: block.tool_use_id, name: toolName, ok, summary });
            }
          }
        }

        if (evt.type === "rate_limit_event" && evt.rate_limit_info) {
          const rl = evt.rate_limit_info;
          onEvent("rate_limit", {
            status: rl.status,
            resetsAt: rl.resetsAt,
            rateLimitType: rl.rateLimitType || "five_hour",
            isUsingOverage: rl.isUsingOverage || false,
          });
        }

        if (evt.type === "result" && evt.usage) {
          const u = evt.usage;
          const inp = u.input_tokens || 0, out = u.output_tokens || 0;
          const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
          const realModels = evt.modelUsage ? Object.keys(evt.modelUsage) : [];
          const realModel = realModels.find((x) => !x.includes("haiku")) || realModels[0] || model || "sonnet";
          const pm = realModel.includes("opus") ? { i:15,o:75,cr:1.5,cw:18.75 }
            : realModel.includes("haiku") ? { i:0.8,o:4,cr:0.08,cw:1 }
            : { i:3,o:15,cr:0.3,cw:3.75 };
          const cost = (inp * pm.i + out * pm.o + cr * pm.cr + cw * pm.cw) / 1e6;
          usage = {
            input: inp, output: out, cacheRead: cr, cacheCreate: cw,
            cost, totalCostUsd: evt.total_cost_usd || cost,
            model: realModel, provider: "claude",
          };
          onEvent("usage", usage);
        }
      }
    });

    let stderrBuf = "";
    proc.stderr.on("data", (c) => { stderrBuf += c.toString(); });

    proc.on("close", (code) => {
      if (code !== 0 && !finalText) {
        const errText = "Erro: " + (stderrBuf || "codigo " + code);
        onEvent("error", { message: errText });
        return resolve({ text: "", usage, error: errText });
      }
      resolve({ text: finalText, usage });
    });

    proc.on("error", (err) => {
      onEvent("error", { message: err.message });
      resolve({ text: finalText, usage, error: err.message });
    });
  });
}

module.exports = { run };
