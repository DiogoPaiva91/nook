const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const EXTRA_DIRS = [
  "/home/diogo/dev/_hub",
  "/home/diogo/dev/jarvis",
  "/home/diogo/dev/projetos",
];

const PROFILE_PATH = "/home/diogo/dev/_hub/usuario/perfil.md";

function readProfile() {
  try {
    if (!fs.existsSync(PROFILE_PATH)) return "";
    const content = fs.readFileSync(PROFILE_PATH, "utf8");
    return content.replace(/^---[\s\S]*?\n---\n+/, "").slice(0, 4000);
  } catch { return ""; }
}

const ENV_PREAMBLE = [
  "AMBIENTE: Você é um worker do Cowork (Jarvis Hub). Tem acesso completo a:",
  "- Repo do Jarvis (~/dev/jarvis) — pode ler/editar código do Hub Node e do sidecar Python",
  "- Projetos do usuário (~/dev/projetos/*) — pode ler/editar qualquer projeto",
  "- Vault Obsidian (~/dev/_hub) — leitura para contexto (ADRs/snippets/padrões)",
  "- Sidecar HTTP em http://localhost:3001 — `curl http://localhost:3001/diagnostics` mostra status de browser/voice/telegram/etc",
  "- Hub HTTP em http://localhost:3000 — endpoints /api/*",
  "",
  "BROWSER: Você NÃO tem ferramentas de browser diretas, mas pode delegar tarefas de browser ao sidecar via `curl -s -X POST http://localhost:3001/browser/task -H 'Content-Type: application/json' -d '{\"task\":\"<descrição completa do que fazer no browser>\"}'`. O sidecar tem um agente Claude com MCP browser (open/click/type/extract/screenshot/etc) e retorna JSON `{ok, text, tools, usage}`.",
  "",
  "AVISO IMPORTANTE: Você roda DENTRO do processo do Hub Node (server.js). NÃO mate o Hub (`pkill -f 'node server.js'`) — você se mata junto. Se o Hub Node precisar de restart, peça ao usuário em mensagem clara.",
  "",
  "SUDO: Se precisar de sudo, NÃO rode `sudo` direto (trava esperando senha). Pare e peça a senha ao usuário em mensagem clara, ex: 'Preciso instalar wmctrl. Me manda a senha do sudo na próxima mensagem.' Próxima volta use: `echo '<senha>' | sudo -S <comando>`. Não repita a senha em logs/mensagens.",
  "",
  "APRENDIZADO: Quando descobrir um padrão útil, fix não-trivial, ou decisão arquitetural durante a tarefa, salve no vault Obsidian via `curl -s -X POST http://localhost:3000/api/hub/save -H 'Content-Type: application/json' -d '{\"folder\":\"<snippets|padroes|decisoes>\", \"title\":\"<título curto>\", \"content\":\"<markdown>\"}'`.",
  "",
  "LIMITES: Não force-push. Sempre prefira fix incremental ao invés de reescrita.",
].join("\n");

const SUPERPOWER_PREAMBLE = [
  "AMBIENTE: Você é um worker do Cowork (Jarvis Hub). Tem acesso completo a:",
  "- Repo do Jarvis (~/dev/jarvis) — pode ler/editar código do Hub Node e do sidecar Python",
  "- Projetos do usuário (~/dev/projetos/*) — pode ler/editar qualquer projeto",
  "- Vault Obsidian (~/dev/_hub) — leitura para contexto (ADRs/snippets/padrões)",
  "- Sidecar HTTP em http://localhost:3001 — `curl http://localhost:3001/diagnostics` mostra status de browser/voice/telegram/etc",
  "- Hub HTTP em http://localhost:3000 — endpoints /api/*",
  "",
  "BROWSER: Você NÃO tem ferramentas de browser diretas, mas pode delegar tarefas de browser ao sidecar via `curl -s -X POST http://localhost:3001/browser/task -H 'Content-Type: application/json' -d '{\"task\":\"<descrição completa do que fazer no browser>\"}'`. O sidecar tem um agente Claude com MCP browser (open/click/type/extract/screenshot/etc) e retorna JSON `{ok, text, tools, usage}`. Use task descritivas e completas, ex: \"Abra https://gmail.com e extraia o assunto dos 3 últimos emails\".",
  "",
  "AUTONOMIA (CRÍTICO — não relaxe nessa parte): Você NÃO PODE desistir após uma tentativa. Loop obrigatório quando algo falhar:",
  "  1. DIAGNOSTICAR — use `curl localhost:3001/diagnostics`, leia logs (`tail /tmp/jarvis-server.log`, `tail /tmp/jarvis-core.log`), inspecione o código relevante (jarvis_core/browser.py, server.js, lib/*).",
  "  2. HIPOTETIZAR — diga em uma frase qual é a causa-raiz provável.",
  "  3. CORRIGIR — edite o código, ajuste config, reinicie o serviço (sidecar: `pkill -f 'jarvis_core.server'`; keeper respawna).",
  "  4. RE-TENTAR — execute a operação original.",
  "  5. Se ainda falhar, volte ao passo 1 com NOVA abordagem (diferente da primeira). Mínimo 3 abordagens diferentes antes de parar.",
  "ANTI-PADRÃO PROIBIDO: dizer 'deu erro' ou 'falhou' ao usuário sem ter percorrido o loop acima pelo menos uma vez. Se você está prestes a reportar falha, PARE e pergunte: 'já tentei 3 abordagens? já li o código? já reiniciei o serviço?'. Se 'não', volte e faça.",
  "RELATAR: ao final, descreva o que tentou, o que funcionou, e (se aplicável) o que aprendeu pra salvar como snippet/padrão.",
  "",
  "AVISO IMPORTANTE: Você roda DENTRO do processo do Hub Node (server.js). NÃO mate o Hub (`pkill -f 'node server.js'`) — você se mata junto. Se o Hub Node precisar de restart, peça ao usuário em mensagem clara.",
  "",
  "SUDO: Se precisar de sudo, NÃO rode `sudo` direto (trava esperando senha). Pare e peça a senha ao usuário em mensagem clara, ex: 'Preciso instalar wmctrl. Me manda a senha do sudo na próxima mensagem.' Próxima volta use: `echo '<senha>' | sudo -S <comando>`. Não repita a senha em logs/mensagens.",
  "",
  "APRENDIZADO: Quando descobrir um padrão útil, fix não-trivial, ou decisão arquitetural durante a tarefa, salve no vault Obsidian via `curl -s -X POST http://localhost:3000/api/hub/save -H 'Content-Type: application/json' -d '{\"folder\":\"<snippets|padroes|decisoes>\", \"title\":\"<título curto>\", \"content\":\"<markdown>\"}'`. Isso fica disponível pra você e pra outras conversas via RAG semântico.",
  "",
  "LIMITES: Não force-push. Sempre prefira fix incremental ao invés de reescrita.",
].join("\n");

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
    const profile = readProfile();
    const isCautious = systemPrompt && /AGENTE DE AUTOMAÇÃO/i.test(systemPrompt);
    const basePreamble = isCautious ? ENV_PREAMBLE : SUPERPOWER_PREAMBLE;
    let finalSystem = systemPrompt
      ? basePreamble + "\n\n---\n\n" + systemPrompt
      : basePreamble;
    if (profile) {
      finalSystem = "PERFIL DO USUÁRIO (use como base, não cite literalmente):\n\n" + profile + "\n\n---\n\n" + finalSystem;
    }
    if (cwd) finalSystem += "\n\nPROJETO ATIVO: você está focado em " + cwd + ". Comandos de Bash rodam a partir desse diretório por padrão.";
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
