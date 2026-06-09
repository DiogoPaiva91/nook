const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const OLLAMA = "http://127.0.0.1:11434";

// ── Worker Cowork ──
const workerRegistry = require("./lib/workers/registry");
const workerBus = require("./lib/workers/bus");
const chatStore = require("./lib/chat/conversations");
const chatSnapshot = require("./lib/chat/snapshot");
const chatDistill = require("./lib/chat/distill");
const codeDb = require("./lib/code/db");
const codeScaffold = require("./lib/code/scaffold");
const codePreamble = require("./lib/workers/providers/_preamble");

// Inspeção de banco = Supabase Studio (sobe com o stack do projeto). Ver
// codeDb.studio() — não há mais GUI interna.
const planLib = require("./lib/plan");
const profileLib = require("./lib/profile");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const UPLOAD_SCOPES = ["chat"];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const MAX_FILES = 5;

// Ensure uploads dirs (one per scope)
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
for (const s of UPLOAD_SCOPES) {
  const p = path.join(UPLOADS_DIR, s);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ── Allowed extensions / MIME ──
const ALLOWED_EXT = new Set([
  ".png",".jpg",".jpeg",".gif",".webp",
  ".pdf",".txt",".md",".csv",".json",".xml",".yaml",".yml",
  ".js",".ts",".jsx",".tsx",".py",".java",".c",".cpp",".h",".hpp",
  ".go",".rs",".rb",".php",".sh",".html",".css",".scss",".sql",
]);
const IMAGE_EXT = new Set([".png",".jpg",".jpeg",".gif",".webp"]);
const MIME_MAP = {
  ".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",
  ".pdf":"application/pdf",".txt":"text/plain",".md":"text/markdown",".csv":"text/csv",
  ".json":"application/json",".xml":"text/xml",".yaml":"text/yaml",".yml":"text/yaml",
  ".js":"text/javascript",".ts":"text/typescript",".jsx":"text/jsx",".tsx":"text/tsx",
  ".py":"text/x-python",".java":"text/x-java",".c":"text/x-c",".cpp":"text/x-c++",
  ".h":"text/x-c",".hpp":"text/x-c++",".go":"text/x-go",".rs":"text/x-rust",
  ".rb":"text/x-ruby",".php":"text/x-php",".sh":"text/x-shellscript",
  ".html":"text/html",".css":"text/css",".scss":"text/x-scss",".sql":"text/x-sql",
};

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function classifyExt(ext) {
  if (IMAGE_EXT.has(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  return "text";
}

// ── SSE helper ──
function sseWrite(res, obj) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
}

// ── Sidecar proxy (nook_core Python on :3001) ──
const CORE_PORT = parseInt(process.env.NOOK_CORE_PORT, 10) || 3001;
function proxyToCore(req, res) {
  const upstreamPath = req.url.replace(/^\/api\/core/, "") || "/";
  const opts = {
    hostname: "127.0.0.1", port: CORE_PORT, path: upstreamPath,
    method: req.method, headers: { ...req.headers, host: `127.0.0.1:${CORE_PORT}` },
  };
  const upstream = http.request(opts, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  upstream.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "core offline: " + e.message }));
  });
  req.pipe(upstream);
}

// ── Multipart parser (minimal, no deps) ──
function parseMultipart(req, callback) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) return callback(new Error("No boundary"), []);
  const boundary = "--" + boundaryMatch[1];
  const chunks = [];
  let totalSize = 0;

  req.on("data", (chunk) => {
    totalSize += chunk.length;
    if (totalSize > MAX_FILE_SIZE * MAX_FILES + 1024 * 1024) {
      req.destroy();
      return callback(new Error("Upload muito grande"), []);
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    const buf = Buffer.concat(chunks);
    const files = [];
    const fields = {};
    const boundaryBuf = Buffer.from(boundary);
    let pos = 0;

    while (pos < buf.length && files.length < MAX_FILES) {
      const start = buf.indexOf(boundaryBuf, pos);
      if (start === -1) break;
      const nextBound = buf.indexOf(boundaryBuf, start + boundaryBuf.length + 2);
      if (nextBound === -1) break;

      const part = buf.slice(start + boundaryBuf.length + 2, nextBound - 2);
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) { pos = nextBound; continue; }

      const headerStr = part.slice(0, headerEnd).toString("utf8");
      const body = part.slice(headerEnd + 4);

      const nameMatch = headerStr.match(/name="([^"]+)"/);
      const filenameMatch = headerStr.match(/filename="([^"]+)"/);
      const ctMatch = headerStr.match(/Content-Type:\s*(.+)/i);

      if (filenameMatch) {
        const origName = filenameMatch[1];
        const mime = ctMatch ? ctMatch[1].trim() : "application/octet-stream";
        if (body.length > MAX_FILE_SIZE) {
          files.push({ error: "Arquivo " + origName + " excede 20MB" });
        } else {
          files.push({ fieldName: nameMatch?.[1] || "file", filename: origName, mime, data: body });
        }
      } else if (nameMatch) {
        fields[nameMatch[1]] = body.toString("utf8");
      }
      pos = nextBound;
    }
    callback(null, files, fields);
  });
}

// ── Upload handler ──
function handleUpload(req, res) {
  parseMultipart(req, (err, files, fields) => {
    if (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: err.message }));
    }

    const scope = UPLOAD_SCOPES.includes(fields?.scope) ? fields.scope : "chat";
    const targetDir = path.join(UPLOADS_DIR, scope);

    const results = [];
    for (const f of files) {
      if (f.error) { results.push({ error: f.error }); continue; }
      const ext = path.extname(f.filename).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        results.push({ error: "Formato nao permitido: " + ext });
        continue;
      }
      const id = Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
      const safeName = sanitizeFilename(f.filename);
      const storedName = id + "_" + safeName;
      const filePath = path.join(targetDir, storedName);
      fs.writeFileSync(filePath, f.data);
      const kind = classifyExt(ext);
      results.push({
        id, filename: f.filename, storedName, path: filePath, scope,
        size: f.data.length, mime: MIME_MAP[ext] || f.mime, kind,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: results }));
  });
}

// ── Upload from existing file path (drag-and-drop from file tree) ──
function handleUploadFromPath(req, res) {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    try {
      const d = body ? JSON.parse(body) : {};
      const src = path.resolve(d.path || "");
      const scope = UPLOAD_SCOPES.includes(d.scope) ? d.scope : "chat";
      if (!src.startsWith("/home/diogo")) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Acesso negado" }));
      }
      if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Arquivo não existe" }));
      }
      const stat = fs.statSync(src);
      if (stat.size > 20 * 1024 * 1024) {
        res.writeHead(413, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Arquivo > 20MB" }));
      }
      const ext = path.extname(src).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Formato não permitido: " + ext }));
      }
      const targetDir = path.join(UPLOADS_DIR, scope);
      try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
      const id = Date.now().toString(36) + "_" + crypto.randomBytes(4).toString("hex");
      const filename = path.basename(src);
      const safeName = sanitizeFilename(filename);
      const storedName = id + "_" + safeName;
      const filePath = path.join(targetDir, storedName);
      fs.copyFileSync(src, filePath);
      const data = fs.readFileSync(filePath);
      const kind = classifyExt(ext);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ files: [{
        id, filename, storedName, path: filePath, scope,
        size: data.length, mime: MIME_MAP[ext] || "application/octet-stream", kind,
      }] }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── Serve uploaded file ──
function serveUpload(id, res) {
  // Search across scope subdirs (and legacy root, for backward compat)
  const searchDirs = [...UPLOAD_SCOPES.map(s => path.join(UPLOADS_DIR, s)), UPLOADS_DIR];
  let filePath = null, matchName = null;
  for (const dir of searchDirs) {
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const m = entries.find(e => e.isFile() && e.name.startsWith(id + "_"));
    if (m) { filePath = path.join(dir, m.name); matchName = m.name; break; }
  }
  if (!filePath) { res.writeHead(404); return res.end("Not found"); }
  const ext = path.extname(matchName).toLowerCase();
  const mime = MIME_MAP[ext] || "application/octet-stream";
  const data = fs.readFileSync(filePath);
  res.writeHead(200, { "Content-Type": mime, "Content-Disposition": "inline" });
  res.end(data);
}

// ── Attachment processing for chat ──
function processAttachmentsForClaude(messages) {
  const processed = [];
  for (const m of messages) {
    if (m.role !== "user" || !m.attachments || !m.attachments.length) {
      processed.push(m);
      continue;
    }
    let extra = "";
    for (const att of m.attachments) {
      if (att.kind === "image") {
        extra += "[Imagem anexada: " + att.path + "]\n";
      } else if (att.kind === "pdf") {
        // Try pdftotext
        try {
          const result = require("child_process").execSync("pdftotext " + JSON.stringify(att.path) + " -", { timeout: 5000, maxBuffer: 200 * 1024 });
          const text = result.toString("utf8").slice(0, 50000);
          extra += "[ANEXO: " + att.filename + "]\n```\n" + text + "\n```\n\n";
        } catch {
          extra += "[ANEXO: " + att.filename + " (PDF - conteudo binario nao extraivel)]\n\n";
        }
      } else {
        // Text/code file: read content
        try {
          const content = fs.readFileSync(att.path, "utf8").slice(0, 50000);
          const ext = path.extname(att.filename).replace(".", "");
          extra += "[ANEXO: " + att.filename + "]\n```" + ext + "\n" + content + "\n```\n\n";
        } catch {
          extra += "[ANEXO: " + att.filename + " (erro ao ler)]\n\n";
        }
      }
    }
    processed.push({ ...m, content: extra + m.content });
  }
  return processed;
}

function processAttachmentsForOllama(messages) {
  const processed = [];
  for (const m of messages) {
    if (m.role !== "user" || !m.attachments || !m.attachments.length) {
      processed.push({ role: m.role, content: m.content });
      continue;
    }
    const images = [];
    let extra = "";
    for (const att of m.attachments) {
      if (att.kind === "image") {
        try {
          const data = fs.readFileSync(att.path);
          images.push(data.toString("base64"));
        } catch {}
      } else if (att.kind === "pdf") {
        try {
          const result = require("child_process").execSync("pdftotext " + JSON.stringify(att.path) + " -", { timeout: 5000, maxBuffer: 200 * 1024 });
          extra += "[ANEXO: " + att.filename + "]\n```\n" + result.toString("utf8").slice(0, 50000) + "\n```\n\n";
        } catch {
          extra += "[ANEXO: " + att.filename + " (PDF)]\n\n";
        }
      } else {
        try {
          const content = fs.readFileSync(att.path, "utf8").slice(0, 50000);
          const ext = path.extname(att.filename).replace(".", "");
          extra += "[ANEXO: " + att.filename + "]\n```" + ext + "\n" + content + "\n```\n\n";
        } catch {}
      }
    }
    const msg = { role: m.role, content: extra + m.content };
    if (images.length) msg.images = images;
    processed.push(msg);
  }
  return processed;
}

// ── Ollama Chat ──
function ollamaChat(model, messages, res, stream, systemPrompt, temperature, headersSent) {
  const msgs = [];
  if (systemPrompt) msgs.push({ role: "system", content: systemPrompt });
  const processed = processAttachmentsForOllama(messages);
  msgs.push(...processed);

  const body = { model, messages: msgs, stream: !!stream };
  if (typeof temperature === "number") body.options = { temperature };

  const payload = JSON.stringify(body);
  const url = new URL(OLLAMA + "/api/chat");

  const req = http.request(
    { hostname: url.hostname, port: url.port, path: url.pathname, method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 300000,
    },
    (ollamaRes) => {
      if (stream) {
        if (!headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
        let inThink = false;
        ollamaRes.on("data", (chunk) => {
          const lines = chunk.toString().split("\n").filter(Boolean);
          for (const line of lines) {
            try {
              const parsed = JSON.parse(line);
              let token = parsed.message?.content || "";
              if (token) {
                while (token.length > 0) {
                  if (!inThink) {
                    const openIdx = token.indexOf("<think>");
                    if (openIdx === -1) { sseWrite(res, { kind: "token", text: token }); break; }
                    if (openIdx > 0) sseWrite(res, { kind: "token", text: token.slice(0, openIdx) });
                    token = token.slice(openIdx + 7); inThink = true;
                  }
                  if (inThink) {
                    const closeIdx = token.indexOf("</think>");
                    if (closeIdx === -1) { if (token) sseWrite(res, { kind: "thinking", text: token }); break; }
                    if (closeIdx > 0) sseWrite(res, { kind: "thinking", text: token.slice(0, closeIdx) });
                    token = token.slice(closeIdx + 8); inThink = false;
                  }
                }
              }
              if (parsed.done) {
                // Ollama includes token counts in the final done message
                if (parsed.prompt_eval_count || parsed.eval_count) {
                  sseWrite(res, {
                    kind: "usage",
                    input: parsed.prompt_eval_count || 0,
                    output: parsed.eval_count || 0,
                    cacheRead: 0, cacheCreate: 0,
                    model: model, provider: "ollama",
                  });
                }
                sseWrite(res, { kind: "done" });
              }
            } catch {}
          }
        });
        ollamaRes.on("end", () => { res.end(); });
      } else {
        let data = "";
        ollamaRes.on("data", (c) => (data += c));
        ollamaRes.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ content: parsed.message?.content || "Sem resposta" }));
          } catch {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ content: "Erro ao processar resposta do Ollama" }));
          }
        });
      }
    }
  );
  req.on("error", () => {
    if (stream) {
      if (!headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      sseWrite(res, { kind: "token", text: "Ollama offline. Rode: ollama serve" });
      sseWrite(res, { kind: "done" }); res.end();
    } else {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content: "Ollama offline. Rode: ollama serve" }));
    }
  });
  req.write(payload); req.end();
}

// ── Claude Chat (stream-json) ──
function claudeChat(model, messages, res, stream, systemPrompt, headersSent, cwd, permissionMode, effort) {
  const processed = processAttachmentsForClaude(messages);
  let prompt = "";
  for (const m of processed) {
    if (m.role === "user") prompt += "User: " + m.content + "\n";
    else if (m.role === "assistant") prompt += "Assistant: " + m.content + "\n";
  }

  // Permission mode: default bypass, but allow "plan" (planeja sem editar) from the composer toggle.
  const ALLOWED_PERM = new Set(["bypassPermissions", "plan", "acceptEdits", "default"]);
  const permMode = ALLOWED_PERM.has(permissionMode) ? permissionMode : "bypassPermissions";
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", permMode];
  // Effort (reasoning power): low|medium|high|xhigh|max — bump for heavy tasks.
  const ALLOWED_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
  const effortLevel = ALLOWED_EFFORT.has(effort) ? effort : null;
  if (effortLevel) args.push("--effort", effortLevel);
  const HUB_DIR = "/home/diogo/dev/_hub";
  if (fs.existsSync(HUB_DIR)) args.push("--add-dir", HUB_DIR);
  if (model) args.push("--model", model);
  // Política de banco: projeto sob ~/dev/projetos usa Postgres (nunca SQLite).
  // Anexada server-side pra valer também em projetos antigos sem a seção no CLAUDE.md.
  if (cwd && typeof cwd === "string" && path.resolve(cwd).startsWith("/home/diogo/dev/projetos/")) {
    systemPrompt = codePreamble.DB_POLICY + (systemPrompt ? "\n\n---\n\n" + systemPrompt : "");
  }
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  let safeCwd = null;
  if (cwd && typeof cwd === "string") {
    const resolved = path.resolve(cwd);
    if (resolved.startsWith("/home/diogo") && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      safeCwd = resolved;
    }
  }

  const startTime = Date.now();
  const t = () => ((Date.now() - startTime) / 1000).toFixed(1);
  let toolCount = 0;
  let permDenials = 0;

  console.log(`[chat t=${t()}] start model=${model} permMode=${permMode}${effortLevel ? " effort=" + effortLevel : ""}${safeCwd ? " cwd=" + safeCwd : ""}`);

  const spawnOpts = { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] };
  if (safeCwd) spawnOpts.cwd = safeCwd;
  const claude = spawn("claude", args, spawnOpts);
  if (!headersSent) res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

  // Cliente abortou o fetch (botao Parar) => a conexao fecha; mata o processo pra nao seguir gastando tokens.
  res.on("error", () => {});
  res.on("close", () => { try { claude.kill("SIGTERM"); } catch {} });

  let lineBuf = "";
  let finalText = "";
  const toolMap = {};

  claude.stdout.on("data", (chunk) => {
    lineBuf += chunk.toString();
    const lines = lineBuf.split("\n");
    lineBuf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "thinking" && block.thinking) sseWrite(res, { kind: "thinking", text: block.thinking });
          else if (block.type === "text" && block.text) { finalText += block.text; sseWrite(res, { kind: "token", text: block.text }); }
          else if (block.type === "tool_use") {
            toolCount++;
            toolMap[block.id] = block.name;
            console.log(`[chat t=${t()}] tool_use ${block.name} ${JSON.stringify(block.input || {}).slice(0, 80)}`);
            sseWrite(res, { kind: "tool", id: block.id, name: block.name, input: block.input || {} });
          }
        }
      } else if (evt.type === "user" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "tool_result") {
            const toolName = toolMap[block.tool_use_id] || "unknown";
            let summary = "", ok = true;
            if (typeof block.content === "string") {
              const resultLines = block.content.split("\n");
              summary = resultLines.length + " linhas";
              // Detect permission denial in content
              const lower = block.content.toLowerCase();
              if (lower.includes("permission") || lower.includes("denied") || lower.includes("not allowed")) {
                ok = false; summary = "permissao negada"; permDenials++;
              }
            }
            if (block.is_error) { ok = false; if (!summary || summary === "erro") summary = "erro"; permDenials++; }
            if (evt.tool_use_result?.file) summary = evt.tool_use_result.file.totalLines + " linhas";
            console.log(`[chat t=${t()}] tool_result ${toolName} ${ok ? "ok" : "FAIL"} ${summary}`);
            sseWrite(res, { kind: "tool_result", id: block.tool_use_id, name: toolName, ok, summary });
          }
        }
      }
      if (evt.type === "rate_limit_event" && evt.rate_limit_info) {
        const rl = evt.rate_limit_info;
        sseWrite(res, {
          kind: "rate_limit",
          status: rl.status,
          resetsAt: rl.resetsAt,
          rateLimitType: rl.rateLimitType || "five_hour",
          isUsingOverage: rl.isUsingOverage || false,
        });
        console.log(`[chat t=${t()}] rate_limit status=${rl.status} resets=${new Date(rl.resetsAt * 1000).toISOString()} type=${rl.rateLimitType}`);
      }
      if (evt.type === "result") {
        if (evt.permission_denials && evt.permission_denials.length) {
          permDenials += evt.permission_denials.length;
          console.log(`[chat t=${t()}] permission_denials:`, evt.permission_denials.length);
        }
        // Emit usage data with cost
        if (evt.usage) {
          const u = evt.usage;
          const inp = u.input_tokens || 0, out = u.output_tokens || 0;
          const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
          // Detect REAL model from modelUsage (CLI may use different model than requested)
          const realModels = evt.modelUsage ? Object.keys(evt.modelUsage) : [];
          const realModel = realModels.find(m => !m.includes("haiku")) || realModels[0] || model || "sonnet";
          // Cost calc (per 1M tokens) based on real model
          const pm = realModel.includes("opus") ? { i:15,o:75,cr:1.5,cw:18.75 }
            : realModel.includes("haiku") ? { i:0.8,o:4,cr:0.08,cw:1 }
            : { i:3,o:15,cr:0.3,cw:3.75 };
          const cost = (inp*pm.i + out*pm.o + cr*pm.cr + cw*pm.cw) / 1e6;
          sseWrite(res, {
            kind: "usage", input: inp, output: out,
            cacheRead: cr, cacheCreate: cw,
            cost, totalCostUsd: evt.total_cost_usd || cost,
            model: realModel, provider: "claude",
          });
          console.log(`[chat t=${t()}] usage in=${inp} out=${out} cacheR=${cr} cacheW=${cw} cost=$${cost.toFixed(4)}`);
        }
        console.log(`[chat t=${t()}] done (${toolCount} tools, ${permDenials} denials)`);
        sseWrite(res, { kind: "done" });
      }
    }
  });

  let stderrBuf = "";
  claude.stderr.on("data", (c) => { stderrBuf += c.toString(); });
  claude.on("close", (code) => {
    if (lineBuf.trim()) { try { const evt = JSON.parse(lineBuf); if (evt.type === "result") sseWrite(res, { kind: "done" }); } catch {} }
    if (code !== 0 && !finalText) {
      console.log(`[chat t=${t()}] exit code=${code} stderr=${stderrBuf.slice(0, 200)}`);
      sseWrite(res, { kind: "token", text: "Erro: " + (stderrBuf || "codigo " + code) });
    }
    sseWrite(res, { kind: "done" });
    if (!res.writableEnded && !res.destroyed) { try { res.end(); } catch {} }
  });
}

// ── Ollama Models ──
function fetchOllamaModels(res) {
  const url = new URL(OLLAMA + "/api/tags");
  const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", timeout: 2000 }, (ollamaRes) => {
    let data = ""; ollamaRes.on("data", (c) => (data += c));
    ollamaRes.on("end", () => {
      try { const p = JSON.parse(data); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ online: true, models: (p.models||[]).map(m=>({name:m.name||m.model,size:m.size||0})) })); }
      catch { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ online: false, models: [] })); }
    });
  });
  req.on("error", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ online: false, models: [] })); });
  req.on("timeout", () => { req.destroy(); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ online: false, models: [] })); });
  req.end();
}

// ── Claude Status ──
function checkClaudeStatus(res) {
  const proc = spawn("claude", ["--version"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 });
  let out = "";
  proc.stdout.on("data", (c) => (out += c.toString()));
  proc.on("close", (code) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ online: code === 0, version: out.trim() })); });
  proc.on("error", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ online: false, version: "" })); });
  setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
}

// ── Desktop shortcut (atalho de app no menu/desktop) ──
// Escreve launcher + ícone + .desktop em ~/.local. Auto-configura node (o
// próprio binário que roda o server), detecta o chrome e bakeia as portas atuais.
function installDesktopShortcut() {
  const HOME = process.env.HOME;
  if (!HOME) throw new Error("HOME não definido");
  const NOOK_DIR = __dirname;
  const NODE = process.execPath;
  const VENV_PY = path.join(NOOK_DIR, ".venv", "bin", "python");
  const CHROME = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"].find((p) => fs.existsSync(p));
  if (!CHROME) throw new Error("Chrome/Chromium não encontrado");

  const binDir = path.join(HOME, ".local", "bin");
  const iconDir = path.join(HOME, ".local", "share", "icons");
  const appsDir = path.join(HOME, ".local", "share", "applications");
  for (const d of [binDir, iconDir, appsDir]) fs.mkdirSync(d, { recursive: true });

  const launcherPath = path.join(binDir, "nook-app");
  const iconPath = path.join(iconDir, "nook-studio.svg");
  const desktopPath = path.join(appsDir, "nook-studio.desktop");

  const launcher = `#!/usr/bin/env bash
# Gerado pelo Nook Studio. Sobe Hub+sidecar se preciso e abre janela de app.
set -euo pipefail
NOOK_DIR=${JSON.stringify(NOOK_DIR)}
LOG_DIR="$HOME/.cache/nook"
URL="http://localhost:${PORT}"
NODE=${JSON.stringify(NODE)}
CHROME=${JSON.stringify(CHROME)}
VENV_PY=${JSON.stringify(VENV_PY)}
mkdir -p "$LOG_DIR"
up() { curl -fsS -o /dev/null --max-time 1 "$1" 2>/dev/null; }
if ! up "http://127.0.0.1:${CORE_PORT}/health"; then
  [ -x "$VENV_PY" ] && ( cd "$NOOK_DIR" && setsid "$VENV_PY" -m nook_core.server >"$LOG_DIR/core.log" 2>&1 </dev/null & )
fi
if ! up "$URL/"; then
  ( cd "$NOOK_DIR" && setsid "$NODE" server.js >"$LOG_DIR/hub.log" 2>&1 </dev/null & )
fi
for _ in $(seq 1 40); do up "$URL/" && break; sleep 0.5; done
exec "$CHROME" --app="$URL" --class=NookStudio >/dev/null 2>&1
`;

  const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect width="256" height="256" rx="56" fill="#121212"/>
  <path d="M84 180 V76 L172 180 V76" fill="none" stroke="#3ECF8E" stroke-width="24" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;

  const desktop = `[Desktop Entry]
Type=Application
Name=Nook Studio
Comment=Workspace de IA do Diogo
Exec=${launcherPath}
Icon=${iconPath}
Terminal=false
Categories=Development;
StartupWMClass=NookStudio
StartupNotify=true
`;

  fs.writeFileSync(launcherPath, launcher);
  fs.chmodSync(launcherPath, 0o755);
  fs.writeFileSync(iconPath, icon);
  fs.writeFileSync(desktopPath, desktop);
  fs.chmodSync(desktopPath, 0o755);
  const cp = require("child_process");
  try { cp.execSync(`update-desktop-database ${JSON.stringify(appsDir)}`, { timeout: 5000, stdio: "ignore" }); } catch {}

  // Ícone clicável na área de trabalho. xdg-user-dir resolve a pasta no locale
  // certo (ex.: "Área de trabalho" em pt-BR); gio trusted evita o bloqueio do GNOME.
  let desktopIconPath = null;
  try {
    let deskDir = "";
    try { deskDir = cp.execSync("xdg-user-dir DESKTOP", { timeout: 3000 }).toString().trim(); } catch {}
    if (!deskDir || !fs.existsSync(deskDir)) {
      deskDir = [path.join(HOME, "Desktop"), path.join(HOME, "Área de trabalho")].find((d) => fs.existsSync(d)) || "";
    }
    if (deskDir && fs.existsSync(deskDir)) {
      desktopIconPath = path.join(deskDir, "nook-studio.desktop");
      fs.copyFileSync(desktopPath, desktopIconPath);
      fs.chmodSync(desktopIconPath, 0o755);
      try { cp.execSync(`gio set ${JSON.stringify(desktopIconPath)} metadata::trusted true`, { timeout: 3000, stdio: "ignore" }); } catch {}
    }
  } catch {}

  return { ok: true, desktopPath, launcherPath, iconPath, desktopIconPath };
}

// ── File Browser (Code Mode) ──
function listFiles(dirPath, res) {
  const safePath = path.resolve(dirPath);
  if (!safePath.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Acesso negado" }));
  }
  try {
    const entries = fs.readdirSync(safePath, { withFileTypes: true });
    const files = entries
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules")
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map(e => ({
        name: e.name,
        path: path.join(safePath, e.name),
        isDir: e.isDirectory(),
        depth: 1,
      }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function readFileContent(filePath, res) {
  const safePath = path.resolve(filePath);
  if (!safePath.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Acesso negado" }));
  }
  try {
    const content = fs.readFileSync(safePath, "utf8");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: content.slice(0, 100000) }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ── Hub (Obsidian vault) ──
const HUB_ROOT = "/home/diogo/dev/_hub";

function hubTreeWalk(dir, base) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(e => !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    })
    .map(e => {
      const full = path.join(dir, e.name);
      const rel = path.relative(base, full);
      if (e.isDirectory()) return { name: e.name, path: rel, isDir: true, children: hubTreeWalk(full, base) };
      if (!e.name.endsWith(".md")) return null;
      return { name: e.name, path: rel, isDir: false };
    })
    .filter(Boolean);
}

function hubTree(res) {
  try {
    if (!fs.existsSync(HUB_ROOT)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ tree: [], hubRoot: HUB_ROOT, exists: false }));
    }
    const tree = hubTreeWalk(HUB_ROOT, HUB_ROOT);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ tree, hubRoot: HUB_ROOT, exists: true }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function extractTitleFromFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fmLine = m[1].split("\n").find(l => /^titulo\s*:/.test(l));
  if (!fmLine) return null;
  return fmLine.replace(/^titulo\s*:\s*/, "").replace(/^["']|["']$/g, "").trim();
}

function stripDatePrefix(name) {
  return name.replace(/^\d{4}-\d{2}-\d{2}-/, "");
}

function buildVaultIndex() {
  const index = {}; // various keys -> rel path
  if (!fs.existsSync(HUB_ROOT)) return index;
  const addKey = (key, rel) => {
    if (!key) return;
    const k = key.toLowerCase().trim();
    if (k && !index[k]) index[k] = rel;
  };
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith(".md")) continue;
      const rel = path.relative(HUB_ROOT, full);
      const baseName = path.basename(rel, ".md");
      addKey(baseName, rel);                         // 2026-04-26-rls-por-owner
      addKey(stripDatePrefix(baseName), rel);        // rls-por-owner
      addKey(rel, rel);                              // padroes/2026-04-26-rls-por-owner.md
      addKey(rel.replace(/\.md$/, ""), rel);         // padroes/2026-04-26-rls-por-owner
      try {
        const content = fs.readFileSync(full, "utf8");
        const title = extractTitleFromFrontmatter(content);
        if (title) addKey(title, rel);               // RLS por owner
      } catch {}
    }
  };
  walk(HUB_ROOT);
  return index;
}

function readHubFile(relPath, res, raw = false) {
  const safePath = path.resolve(HUB_ROOT, relPath);
  if (!safePath.startsWith(HUB_ROOT + path.sep) && safePath !== HUB_ROOT) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Acesso negado" }));
  }
  try {
    const content = fs.readFileSync(safePath, "utf8");
    // Resolve wikilinks
    const index = buildVaultIndex();
    const wikilinks = {};
    const matches = content.match(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g) || [];
    const tryKeys = (target) => {
      const t = target.toLowerCase().trim();
      const candidates = [
        t,
        t + ".md",
        t.replace(/\.md$/, ""),
        path.basename(t, ".md"),
        stripDatePrefix(path.basename(t, ".md")),
      ];
      for (const k of candidates) {
        if (index[k]) return index[k];
      }
      return null;
    };
    for (const m of matches) {
      const r = m.replace(/^\[\[|\]\]$/g, "");
      const target = r.split("|")[0].split("#")[0].trim();
      wikilinks[target] = tryKeys(target);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ content: raw ? content : content.slice(0, 200000), path: relPath, wikilinks }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function deleteHubFile(relPath, res) {
  const safePath = path.resolve(HUB_ROOT, relPath);
  if (!safePath.startsWith(HUB_ROOT + path.sep) || safePath === HUB_ROOT) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Acesso negado" }));
  }
  try {
    if (!fs.existsSync(safePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Arquivo nao encontrado" }));
    }
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Caminho e um diretorio" }));
    }
    fs.unlinkSync(safePath);
    // Trigger reindex so embeddings drop the deleted note
    fetch("http://localhost:3001/embed/reindex", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      signal: AbortSignal.timeout(15000),
    }).catch(() => {});
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: relPath }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function updateHubFile(data, res) {
  const relPath = (data.path || "").trim();
  const content = typeof data.content === "string" ? data.content : "";
  if (!relPath) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Caminho obrigatorio" }));
  }
  const safePath = path.resolve(HUB_ROOT, relPath);
  if (!safePath.startsWith(HUB_ROOT + path.sep) || safePath === HUB_ROOT) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Acesso negado" }));
  }
  try {
    if (!fs.existsSync(safePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Arquivo nao encontrado" }));
    }
    const stat = fs.statSync(safePath);
    if (stat.isDirectory()) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Caminho e um diretorio" }));
    }
    fs.writeFileSync(safePath, content);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: relPath }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function hubGraph(res) {
  try {
    const nodes = [];
    const edges = [];
    nodes.push({ id: "nook", label: "Nook", group: "core", size: 30, font: { size: 18 } });

    // Track all files for wikilink resolution: name -> rel path
    const fileIndex = {}; // basename (lower, no ext) -> rel path
    const fileContents = {}; // rel path -> raw content

    const indexFile = (full, rel) => {
      const baseName = path.basename(rel, ".md").toLowerCase();
      if (!fileIndex[baseName]) fileIndex[baseName] = rel;
      try { fileContents[rel] = fs.readFileSync(full, "utf8"); } catch {}
    };

    if (fs.existsSync(HUB_ROOT)) {
      const folders = fs.readdirSync(HUB_ROOT, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith("."));
      for (const f of folders) {
        const fid = "folder:" + f.name;
        nodes.push({ id: fid, label: f.name, group: "folder", size: 18 });
        edges.push({ from: "nook", to: fid, length: 200 });
        const walk = (dir, depth) => {
          if (depth > 4) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.name.startsWith(".")) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            if (!e.name.endsWith(".md")) continue;
            const rel = path.relative(HUB_ROOT, full);
            const nid = "file:" + rel;
            const label = e.name.replace(/\.md$/, "").slice(0, 30);
            nodes.push({ id: nid, label, group: "file", size: 12, title: rel });
            edges.push({ from: fid, to: nid });
            indexFile(full, rel);
          }
        };
        walk(path.join(HUB_ROOT, f.name), 0);
      }
      // root-level .md
      const rootEntries = fs.readdirSync(HUB_ROOT, { withFileTypes: true });
      for (const e of rootEntries) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        const nid = "file:" + e.name;
        nodes.push({ id: nid, label: e.name.replace(/\.md$/, ""), group: "file", size: 14, title: e.name });
        edges.push({ from: "nook", to: nid });
        indexFile(path.join(HUB_ROOT, e.name), e.name);
      }

      // Wikilinks: scan all files and create file->file edges
      const fullIndex = buildVaultIndex();
      const seenWikiEdges = new Set();
      const tryKeys = (target) => {
        const t = target.toLowerCase().trim();
        const candidates = [t, t + ".md", t.replace(/\.md$/, ""), path.basename(t, ".md"), stripDatePrefix(path.basename(t, ".md"))];
        for (const k of candidates) if (fullIndex[k]) return fullIndex[k];
        return null;
      };
      for (const [rel, content] of Object.entries(fileContents)) {
        const matches = content.match(/\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g) || [];
        for (const m of matches) {
          const target = m.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].trim();
          const targetRel = tryKeys(target);
          if (!targetRel || targetRel === rel) continue;
          const edgeKey = rel + "->" + targetRel;
          if (seenWikiEdges.has(edgeKey)) continue;
          seenWikiEdges.add(edgeKey);
          edges.push({
            from: "file:" + rel,
            to: "file:" + targetRel,
            color: { color: "rgba(34,197,94,0.45)" },
            width: 2,
            dashes: false,
            arrows: { to: { enabled: true, scaleFactor: 0.5 } },
            wikilink: true,
          });
        }
      }
    }

    try {
      const convs = chatStore.listChats();
      const recent = convs.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50);
      const convGroup = { id: "convs", label: "Conversas", group: "convgroup", size: 20 };
      nodes.push(convGroup);
      edges.push({ from: "nook", to: "convs", length: 200 });
      for (const c of recent) {
        const nid = "conv:" + c.id;
        const label = (c.title || "(sem titulo)").slice(0, 30);
        nodes.push({ id: nid, label, group: "conv", size: 10, title: c.title || "" });
        edges.push({ from: "convs", to: nid });
      }
    } catch (e) { /* ignore conv errors */ }

    // Projects (~/dev/projetos/*)
    try {
      if (fs.existsSync(PROJETOS_ROOT)) {
        const projGroup = { id: "projetos", label: "Projetos", group: "projgroup", size: 20 };
        nodes.push(projGroup);
        edges.push({ from: "nook", to: "projetos", length: 200 });
        const projEntries = fs.readdirSync(PROJETOS_ROOT, { withFileTypes: true })
          .filter(e => e.isDirectory() && !e.name.startsWith("."));
        for (const p of projEntries) {
          const full = path.join(PROJETOS_ROOT, p.name);
          let hasGit = false, hasBmad = false;
          try { hasGit = fs.existsSync(path.join(full, ".git")); } catch {}
          try { hasBmad = fs.existsSync(path.join(full, "_bmad")); } catch {}
          const tags = [hasGit && "git", hasBmad && "BMAD"].filter(Boolean);
          const nid = "project:" + p.name;
          nodes.push({ id: nid, label: p.name, group: hasBmad ? "projectBmad" : "project", size: 14, title: p.name + (tags.length ? " (" + tags.join(", ") + ")" : "") });
          edges.push({ from: "projetos", to: nid });
        }
      }
    } catch (e) { /* ignore project errors */ }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodes, edges, stats: { nodes: nodes.length, edges: edges.length } }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

const HUB_STOPWORDS = new Set([
  "o","a","os","as","de","da","do","das","dos","e","em","no","na","nas","nos","para","por","com",
  "que","qual","como","quem","onde","quando","ser","tem","mais","seu","sua","mas","ou","se","um","uma","uns","umas",
  "the","and","to","in","for","with","what","how","when","where","is","of","at","on","be","this","that","an","or"
]);

function tokenizeForHub(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2 && !HUB_STOPWORDS.has(t));
}

// Detect active project name from cwd (returns null if cwd is not a project)
function activeProjectFromCwd(cwd) {
  if (!cwd || typeof cwd !== "string") return null;
  const m = cwd.match(/^\/home\/diogo\/dev\/projetos\/([^\/]+)/);
  return m ? m[1] : null;
}

// Folders that are noise when working inside a project. Macros/templates/inbox
// don't help code work — they're personal automation/draft buckets.
const HUB_PROJECT_NOISE_FOLDERS = ["macros/", "templates/", "inbox/", "arquivo/"];

// Reject notes from OTHER projects when working inside a specific project.
// Heuristics:
//   - projetos/<other>.md or projetos/<other>/... → reject if <other> != active
//   - any note tagged code-<other> in frontmatter (without also code-<active>) → reject
//   - notes under macros/, templates/, inbox/, arquivo/ → reject (noise)
function isOtherProjectNote(notePath, activeProj, fileContent) {
  if (!activeProj || !notePath) return false;
  for (const folder of HUB_PROJECT_NOISE_FOLDERS) {
    if (notePath.startsWith(folder)) return true;
  }
  const m = notePath.match(/^projetos\/(?:brief-)?([^\/]+?)(?:\.md|\/.*)?$/);
  if (m && m[1] !== activeProj) return true;
  // Check frontmatter tags for code-<X>. Snapshot writer slugifies the kind
  // ("code:gestao_opa" -> "code-gestao-opa"), so apply same normalization here.
  if (fileContent) {
    const fm = fileContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fm) {
      const tagMatch = fm[1].match(/tags\s*:\s*\[([^\]]*)\]/i);
      if (tagMatch) {
        const tags = tagMatch[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
        const codeTags = tags.filter(t => t.startsWith("code-"));
        if (codeTags.length) {
          const activeSlug = "code-" + activeProj.toLowerCase().replace(/[^a-z0-9]+/g, "-");
          const hasActive = codeTags.some(t => t === "code-" + activeProj || t === activeSlug);
          const hasOther = codeTags.some(t => t !== "code-" + activeProj && t !== activeSlug);
          if (hasOther && !hasActive) return true;
        }
      }
    }
  }
  return false;
}

function snippetForTerms(content, terms, max) {
  max = max || 240;
  if (!content) return "";
  if (!terms || !terms.length) return content.slice(0, max);
  const lower = content.toLowerCase();
  let bestIdx = -1, bestTerm = "";
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (bestIdx === -1 || i < bestIdx)) { bestIdx = i; bestTerm = t; }
  }
  if (bestIdx === -1) return content.slice(0, max);
  const start = Math.max(0, bestIdx - 60);
  const end = Math.min(content.length, bestIdx + bestTerm.length + max - 60);
  return (start > 0 ? "..." : "") + content.slice(start, end).replace(/\s+/g, " ").trim() + (end < content.length ? "..." : "");
}

async function findHubContextSemantic(query, limit, cwd) {
  limit = limit || 3;
  const activeProj = activeProjectFromCwd(cwd);
  try {
    const fetchLimit = activeProj ? Math.max(limit * 3, 8) : limit;
    const minScore = activeProj ? 0.6 : 0.4;
    const url = "http://localhost:3001/embed/search?q=" + encodeURIComponent(query) + "&top_k=" + fetchLimit + "&min_score=" + minScore;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return [];
    const d = await r.json();
    if (!Array.isArray(d.results) || !d.results.length) return [];
    const queryTokens = tokenizeForHub(query);
    const out = [];
    for (const it of d.results) {
      if (!it.path) continue;
      const full = path.join(HUB_ROOT, it.path);
      // Skip stale index entries: file may have been deleted but still indexed
      if (!fs.existsSync(full)) continue;
      let raw = "";
      try { raw = fs.readFileSync(full, "utf8"); } catch { continue; }
      if (isOtherProjectNote(it.path, activeProj, raw)) continue;
      const content = raw.replace(/^---[\s\S]*?\n---\n+/, "");
      const lower = content.toLowerCase();
      const matchedTerms = queryTokens.filter(t => lower.includes(t));
      const snippet = snippetForTerms(content, matchedTerms.length ? matchedTerms : queryTokens, 220);
      out.push({ path: it.path, content, score: it.score || 0, matchedTerms, snippet, reason: "semantic similarity" });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

function findHubContext(query, limit, cwd) {
  limit = limit || 3;
  if (!fs.existsSync(HUB_ROOT)) return [];
  const activeProj = activeProjectFromCwd(cwd);
  const queryTokens = tokenizeForHub(query);
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
      const rel = path.relative(HUB_ROOT, full);
      try {
        const content = fs.readFileSync(full, "utf8");
        if (isOtherProjectNote(rel, activeProj, content)) continue;
        const tokens = tokenizeForHub(content);
        if (!tokens.length) continue;
        const tokenSet = new Set(tokens);
        let score = 0;
        const matchedTerms = [];
        for (const qt of Object.keys(queryFreq)) {
          if (!tokenSet.has(qt)) continue;
          matchedTerms.push(qt);
          const occurrences = tokens.filter(t => t === qt).length;
          score += 1 + Math.min(occurrences, 8) * 0.25 + queryFreq[qt] * 0.5;
        }
        if (score > 0) {
          const cleanContent = content.replace(/^---[\s\S]*?\n---\n+/, "");
          results.push({
            path: rel,
            content: cleanContent,
            score,
            matchedTerms,
            snippet: snippetForTerms(cleanContent, matchedTerms, 220),
            reason: "matched: " + matchedTerms.slice(0, 5).join(", "),
          });
        }
      } catch {}
    }
  };
  walk(HUB_ROOT);
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

async function fetchAutoTags(title, content, kind) {
  try {
    const r = await fetch("http://localhost:3001/hub/suggest-tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content, kind: kind || "snippet" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.tags) ? d.tags.slice(0, 6) : [];
  } catch { return []; }
}

async function saveHubNote(data, res) {
  const ALLOWED_FOLDERS = ["snippets", "decisoes", "padroes", "inbox", "arquivo", "conversas"];
  const folder = (data.folder || "").trim();
  const title = (data.title || "").trim();
  const content = data.content || "";
  if (!ALLOWED_FOLDERS.includes(folder)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Pasta invalida. Use: " + ALLOWED_FOLDERS.join(", ") }));
  }
  if (!title) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Titulo obrigatorio" }));
  }
  const slug = title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "nota";
  const date = new Date().toISOString().slice(0, 10);
  const folderPath = path.join(HUB_ROOT, folder);
  fs.mkdirSync(folderPath, { recursive: true });
  let filename = `${date}-${slug}.md`;
  let i = 1;
  while (fs.existsSync(path.join(folderPath, filename))) {
    filename = `${date}-${slug}-${i}.md`;
    i++;
  }
  const fullPath = path.join(folderPath, filename);
  const tagMap = { snippets: "snippet", decisoes: "adr, decisao", padroes: "padrao", inbox: "inbox", arquivo: "arquivo" };
  const baseTags = (tagMap[folder] || folder).split(",").map(t => t.trim()).filter(Boolean);
  let extraTags = [];
  if (data.autoTags !== false) {
    const tagKindMap = { snippets: "snippet", decisoes: "adr", padroes: "padrao" };
    extraTags = await fetchAutoTags(title, content, tagKindMap[folder] || "nota");
  }
  const allTags = Array.from(new Set([...baseTags, ...extraTags]));
  const fm = `---\ntitulo: ${title.replace(/\n/g, " ")}\ndata: ${date}\nfonte: nook-chat\ntags: [${allTags.join(", ")}]\n---\n\n# ${title}\n\n`;
  fs.writeFileSync(fullPath, fm + content + "\n");
  const relPath = path.relative(HUB_ROOT, fullPath);
  // Fire-and-forget: reindex embeddings so semantic search picks up the new note
  fetch("http://localhost:3001/embed/reindex", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(15000),
  }).catch(() => {});
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, path: relPath, fullPath, tags: allTags }));
}

// ── Projects (~/dev/projetos/*) ──
const PROJETOS_ROOT = path.join(process.env.HOME || "/home/diogo", "dev", "projetos");

const PREVIEW_MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function servePreviewFile(projectName, subPath, res) {
  const projectDir = path.join(PROJETOS_ROOT, projectName);
  const stripped = (subPath || "/").replace(/^\/+/, "");
  let target = path.resolve(projectDir, stripped || "index.html");
  // Prevent traversal
  if (!target.startsWith(projectDir + path.sep) && target !== projectDir) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("forbidden");
  }
  if (!fs.existsSync(target)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found: " + path.relative(projectDir, target));
  }
  let stat;
  try { stat = fs.statSync(target); } catch (e) {
    res.writeHead(500); return res.end("stat error");
  }
  if (stat.isDirectory()) {
    // Try index.html in directory
    const idx = path.join(target, "index.html");
    if (fs.existsSync(idx)) target = idx;
    else { res.writeHead(404); return res.end("directory listing disabled"); }
  }
  const ext = path.extname(target).toLowerCase();
  const mime = PREVIEW_MIME[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-cache, no-store, must-revalidate" });
  fs.createReadStream(target).pipe(res);
}

function listHtmls(rootPath, res) {
  const safePath = path.resolve(rootPath);
  if (!safePath.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Acesso negado" }));
  }
  const SKIP = new Set(["node_modules", ".git", "_bmad", "_bmad-output", ".bmad-core", "dist", "build", ".cache", ".next"]);
  const results = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      const lower = e.name.toLowerCase();
      if (lower.endsWith(".html") || lower.endsWith(".htm") || lower.endsWith(".svg")) {
        try {
          const stat = fs.statSync(full);
          results.push({
            path: full,
            relative: path.relative(safePath, full),
            name: e.name,
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } catch {}
      }
    }
  };
  if (fs.existsSync(safePath)) walk(safePath, 0);
  results.sort((a, b) => b.mtime - a.mtime);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ files: results, count: results.length, root: safePath }));
}

function listProjects(res) {
  try {
    if (!fs.existsSync(PROJETOS_ROOT)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ projects: [] }));
    }
    const entries = fs.readdirSync(PROJETOS_ROOT, { withFileTypes: true });
    const projects = entries
      .filter(e => e.isDirectory() && !e.name.startsWith("."))
      .map(e => {
        const full = path.join(PROJETOS_ROOT, e.name);
        let hasGit = false, hasBmad = false;
        try { hasGit = fs.existsSync(path.join(full, ".git")); } catch {}
        try { hasBmad = fs.existsSync(path.join(full, "_bmad")); } catch {}
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch {}
        return { name: e.name, path: full, hasGit, hasBmad, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ projects }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function deleteProject(name, res) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/.test(name)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Nome invalido" }));
  }
  const target = path.join(PROJETOS_ROOT, name);
  const resolved = path.resolve(target);
  if (!resolved.startsWith(PROJETOS_ROOT + path.sep)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Caminho fora de projetos/" }));
  }
  if (!fs.existsSync(resolved)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Projeto nao encontrado" }));
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    const removedNotes = [];
    // Remove line from hub index if present
    try {
      const indexPath = path.join(HUB_ROOT, "projetos", "index.md");
      if (fs.existsSync(indexPath)) {
        const content = fs.readFileSync(indexPath, "utf8");
        const filtered = content.split("\n")
          .filter(line => !line.includes("/" + name + "/README"))
          .join("\n");
        if (filtered !== content) fs.writeFileSync(indexPath, filtered);
      }
    } catch {}
    // Remove orphan notes <name>.md and brief-<name>.md in _hub/projetos/
    try {
      const projetosDir = path.join(HUB_ROOT, "projetos");
      for (const fname of [name + ".md", "brief-" + name + ".md"]) {
        const noteFull = path.resolve(path.join(projetosDir, fname));
        if (noteFull.startsWith(projetosDir + path.sep) && fs.existsSync(noteFull)) {
          fs.rmSync(noteFull, { force: true });
          removedNotes.push(fname);
        }
      }
    } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, name, removedNotes }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

function createProject(data, res) {
  const name = (data.name || "").trim();
  const bmad = !!data.bmad;
  const bmadVersioned = !!data.bmadVersioned;
  const description = (data.description || "").trim();
  const kind = (data.kind || "other").trim();
  const stack = Array.isArray(data.stack) ? data.stack.filter(s => typeof s === "string" && s.trim()).map(s => s.trim()) : [];
  const hubNote = !!data.hubNote;
  const runAnalyst = !!data.runAnalyst;
  const template = (data.template || "").trim() || null;
  const source = (data.source || "scaffold").trim();
  const localPath = (data.localPath || "").trim();
  const githubRepo = (data.githubRepo || "").trim();
  const githubBranch = (data.githubBranch || "").trim();
  // Stream output via SSE-style chunked response
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  const send = (kind, payload) => { try { res.write("data: " + JSON.stringify({ kind, ...payload }) + "\n\n"); } catch {} };

  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) {
    send("error", { error: "Nome invalido (use letras, numeros, - e _)" });
    return res.end();
  }
  const target = path.join(PROJETOS_ROOT, name);
  if (fs.existsSync(target)) {
    send("error", { error: "Projeto " + name + " ja existe" });
    return res.end();
  }

  const ctx = { name, target, description, kind, stack, bmad, hubNote, runAnalyst, template, source };
  if (source === "local") return _createProjectFromLocal({ ctx, localPath, send, res });
  if (source === "github") return _createProjectFromGithub({ ctx, githubRepo, githubBranch, send, res });

  // Default: scaffold via newproj script
  send("status", { phase: "starting", message: "Iniciando newproj..." });
  const args = [name, bmad ? "--bmad" : "--no-bmad"];
  if (bmadVersioned) args.push("--bmad-versioned");
  const scriptPath = path.join(process.env.HOME || "/home/diogo", "dev", "bin", "newproj");
  const newproj = spawn(scriptPath, args, { stdio: ["ignore", "pipe", "pipe"] });

  let stderrBuf = "";
  const flushLines = (buf, kind) => {
    const lines = buf.split("\n");
    for (const ln of lines) {
      if (ln.trim()) send(kind, { line: ln });
    }
  };
  let stdoutBuf = "";
  newproj.stdout.on("data", c => {
    stdoutBuf += c.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.trim()) send("stdout", { line });
    }
  });
  newproj.stderr.on("data", c => {
    const s = c.toString();
    stderrBuf += s;
    flushLines(s, "stderr");
  });
  newproj.on("close", async (code) => {
    if (stdoutBuf.trim()) send("stdout", { line: stdoutBuf });
    if (code !== 0 || !fs.existsSync(target)) {
      send("error", { error: stderrBuf.slice(0, 800) || "newproj falhou (exit " + code + ")" });
      return res.end();
    }
    try {
      await postCreateEnrichProject({ name, target, description, kind, stack, bmad, hubNote, runAnalyst, template, send });
    } catch (e) {
      send("stderr", { line: "[enrich] " + (e.message || String(e)) });
    }
    send("done", { ok: true, name, path: target });
    res.end();
  });
  newproj.on("error", (e) => {
    send("error", { error: e.message });
    res.end();
  });
}

function _createProjectFromLocal({ ctx, localPath, send, res }) {
  if (!localPath) { send("error", { error: "Caminho local obrigatorio" }); return res.end(); }
  const resolved = path.resolve(localPath);
  if (!resolved.startsWith("/home/diogo/")) {
    send("error", { error: "Caminho deve estar em /home/diogo/" });
    return res.end();
  }
  if (resolved.startsWith(PROJETOS_ROOT + path.sep) || resolved === PROJETOS_ROOT) {
    send("error", { error: "Origem nao pode estar em ~/dev/projetos/ (criaria recursao)" });
    return res.end();
  }
  if (!fs.existsSync(resolved)) { send("error", { error: "Caminho nao existe: " + resolved }); return res.end(); }
  if (!fs.statSync(resolved).isDirectory()) { send("error", { error: "Caminho nao e um diretorio" }); return res.end(); }
  send("status", { phase: "starting", message: "Copiando " + resolved + " -> " + ctx.target + "..." });
  // cp -r preserves symlinks; --no-preserve=ownership keeps user perms
  const cp = spawn("cp", ["-r", "--no-preserve=ownership", resolved + "/.", ctx.target], { stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  cp.stderr.on("data", c => { stderrBuf += c.toString(); });
  cp.stdout.on("data", c => { for (const ln of c.toString().split("\n")) if (ln.trim()) send("stdout", { line: ln }); });
  cp.on("close", async (code) => {
    if (code !== 0 || !fs.existsSync(ctx.target)) {
      send("error", { error: stderrBuf.slice(0, 800) || "cp falhou (exit " + code + ")" });
      return res.end();
    }
    send("status", { phase: "starting", message: "Copia concluida" });
    // Init git if absent
    if (!fs.existsSync(path.join(ctx.target, ".git"))) {
      try {
        await new Promise((resolve) => {
          const gp = spawn("bash", ["-c", "git init -q && git add -A && git commit -q -m 'import: " + ctx.name + " (local)' || true"], { cwd: ctx.target, stdio: ["ignore", "pipe", "pipe"] });
          gp.on("close", () => resolve());
          gp.on("error", () => resolve());
        });
      } catch {}
    }
    try {
      await postCreateEnrichProject({ ...ctx, send });
    } catch (e) { send("stderr", { line: "[enrich] " + (e.message || String(e)) }); }
    send("done", { ok: true, name: ctx.name, path: ctx.target });
    res.end();
  });
  cp.on("error", (e) => { send("error", { error: e.message }); res.end(); });
}

function _createProjectFromGithub({ ctx, githubRepo, githubBranch, send, res }) {
  if (!githubRepo) { send("error", { error: "Repositorio GitHub obrigatorio" }); return res.end(); }
  let url = githubRepo;
  // owner/repo → URL
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(githubRepo)) {
    url = "https://github.com/" + githubRepo + ".git";
  }
  // Validate URL pattern
  if (!/^(https:\/\/github\.com\/|git@github\.com:)[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(\.git)?$/.test(url)) {
    send("error", { error: "URL/repo invalido. Use 'owner/repo' ou URL https://github.com/..." });
    return res.end();
  }
  send("status", { phase: "starting", message: "git clone " + url + (githubBranch ? " (--branch " + githubBranch + ")" : "") + "..." });
  const args = ["clone", "--depth", "1"];
  if (githubBranch) { args.push("--branch", githubBranch); }
  args.push(url, ctx.target);
  const gc = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrBuf = "";
  gc.stderr.on("data", c => {
    const s = c.toString();
    stderrBuf += s;
    for (const ln of s.split("\n")) if (ln.trim()) send("stdout", { line: ln });
  });
  gc.stdout.on("data", c => { for (const ln of c.toString().split("\n")) if (ln.trim()) send("stdout", { line: ln }); });
  gc.on("close", async (code) => {
    if (code !== 0 || !fs.existsSync(ctx.target)) {
      send("error", { error: stderrBuf.slice(-800) || "git clone falhou (exit " + code + ")" });
      return res.end();
    }
    send("status", { phase: "starting", message: "Clone concluido" });
    try {
      await postCreateEnrichProject({ ...ctx, send });
    } catch (e) { send("stderr", { line: "[enrich] " + (e.message || String(e)) }); }
    send("done", { ok: true, name: ctx.name, path: ctx.target });
    res.end();
  });
  gc.on("error", (e) => { send("error", { error: e.message }); res.end(); });
}

// Scaffold Vite + React + TS + Tailwind (default for kind=web). Writes config files; npm install streamed.
async function scaffoldViteReact({ name, target, send }) {
  send("status", { phase: "scaffold", message: "Gerando template Vite + React + TS + Tailwind..." });
  const w = (rel, content) => {
    const p = path.join(target, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  const pkg = {
    name,
    private: true,
    version: "0.0.0",
    type: "module",
    scripts: {
      dev: "vite",
      build: "tsc && vite build",
      preview: "vite preview",
    },
    dependencies: {
      "react": "^18.3.1",
      "react-dom": "^18.3.1",
      "lucide-react": "^0.460.0",
      "class-variance-authority": "^0.7.1",
      "clsx": "^2.1.1",
      "tailwind-merge": "^2.5.5",
    },
    devDependencies: {
      "@types/react": "^18.3.18",
      "@types/react-dom": "^18.3.5",
      "@vitejs/plugin-react": "^4.3.4",
      "autoprefixer": "^10.4.20",
      "postcss": "^8.4.49",
      "tailwindcss": "^3.4.17",
      "tailwindcss-animate": "^1.0.7",
      "typescript": "^5.7.2",
      "vite": "^6.0.3",
    },
  };
  w("package.json", JSON.stringify(pkg, null, 2) + "\n");

  w("index.html",
`<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
    <script src="http://localhost:3000/nook-picker.js"></script>
  </body>
</html>
`);

  w("vite.config.ts",
`import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
`);

  w("tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2020",
      useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"],
      module: "ESNext",
      skipLibCheck: true,
      moduleResolution: "bundler",
      allowImportingTsExtensions: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true,
      jsx: "react-jsx",
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noFallthroughCasesInSwitch: true,
      baseUrl: ".",
      paths: { "@/*": ["./src/*"] },
    },
    include: ["src"],
    references: [{ path: "./tsconfig.node.json" }],
  }, null, 2) + "\n");

  w("tsconfig.node.json", JSON.stringify({
    compilerOptions: {
      composite: true,
      skipLibCheck: true,
      module: "ESNext",
      moduleResolution: "bundler",
      allowSyntheticDefaultImports: true,
      strict: true,
    },
    include: ["vite.config.ts"],
  }, null, 2) + "\n");

  w("tailwind.config.js",
`import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: { center: true, padding: "2rem", screens: { "2xl": "1400px" } },
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [animate],
};
`);

  w("postcss.config.js",
`export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`);

  w("components.json", JSON.stringify({
    "$schema": "https://ui.shadcn.com/schema.json",
    style: "default",
    rsc: false,
    tsx: true,
    tailwind: {
      config: "tailwind.config.js",
      css: "src/index.css",
      baseColor: "slate",
      cssVariables: true,
      prefix: "",
    },
    aliases: {
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui",
      lib: "@/lib",
      hooks: "@/hooks",
    },
  }, null, 2) + "\n");

  w("src/main.tsx",
`import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`);

  w("src/App.tsx",
`import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function App() {
  const [nome, setNome] = useState("");
  return (
    <div className="dark min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>${name}</CardTitle>
          <CardDescription>Vite + React + TS + Tailwind + shadcn</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="Seu nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          <Button onClick={() => alert("Hello, " + (nome || "mundo") + "!")} className="w-full">
            Cumprimentar
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
`);

  w("src/index.css",
`@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;
  }
  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --popover: 222.2 84% 4.9%;
    --popover-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}

@layer base {
  * { @apply border-border; }
  body { @apply bg-background text-foreground; }
}
`);

  // shadcn components — mirror upstream output
  w("src/components/ui/button.tsx",
`import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
`);

  w("src/components/ui/card.tsx",
`import * as React from "react";
import { cn } from "@/lib/utils";

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("rounded-lg border bg-card text-card-foreground shadow-sm", className)} {...props} />
  )
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />
  )
);
CardHeader.displayName = "CardHeader";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-2xl font-semibold leading-none tracking-tight", className)} {...props} />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-6 pt-0", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("flex items-center p-6 pt-0", className)} {...props} />
  )
);
CardFooter.displayName = "CardFooter";

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
`);

  w("src/components/ui/input.tsx",
`import * as React from "react";
import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = "Input";

export { Input };
`);

  w("src/lib/utils.ts",
`import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
`);

  send("status", { phase: "scaffold", message: "Arquivos do template gravados" });

  // npm install (streamed)
  send("status", { phase: "install", message: "Rodando npm install (pode levar 30-60s)..." });
  await new Promise((resolve) => {
    const ni = spawn("npm", ["install", "--no-audit", "--no-fund"], {
      cwd: target,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    ni.stdout.on("data", c => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) send("stdout", { line: "[npm] " + line });
      }
    });
    ni.stderr.on("data", c => {
      const lines = c.toString().split("\n");
      for (const ln of lines) if (ln.trim()) send("stderr", { line: "[npm] " + ln });
    });
    ni.on("close", code => {
      if (buf.trim()) send("stdout", { line: "[npm] " + buf });
      if (code === 0) send("status", { phase: "install", message: "Dependencias instaladas" });
      else send("stderr", { line: "[npm] exit " + code });
      resolve();
    });
    ni.on("error", e => { send("stderr", { line: "[npm] " + e.message }); resolve(); });
  });

  // Commit scaffold
  await new Promise((resolve) => {
    const gp = spawn("bash", ["-c", "git add -A && git commit -q -m 'scaffold: vite+react+ts+tailwind' || true"], {
      cwd: target, stdio: ["ignore", "pipe", "pipe"],
    });
    gp.on("close", () => resolve());
    gp.on("error", () => resolve());
  });
}

// Try delegating CLAUDE.md generation to Anthropic's `claude /init` slash command.
// Returns true if claude CLI ran successfully and CLAUDE.md was created.
async function tryClaudeInit(target, send) {
  // Check claude CLI is on PATH
  const hasClaude = await new Promise((resolve) => {
    const p = spawn("which", ["claude"], { stdio: ["ignore", "pipe", "pipe"] });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
  if (!hasClaude) return false;

  send("status", { phase: "claude-init", message: "Rodando claude /init (analisa codebase, ~30-90s)..." });
  return new Promise((resolve) => {
    let killed = false;
    const p = spawn("claude", ["--dangerously-skip-permissions", "-p", "/init"], {
      cwd: target,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    p.stdout.on("data", (c) => {
      const lines = c.toString().split("\n");
      for (const ln of lines) if (ln.trim()) send("stdout", { line: "[claude] " + ln });
    });
    p.stderr.on("data", (c) => {
      const lines = c.toString().split("\n");
      for (const ln of lines) if (ln.trim()) send("stderr", { line: "[claude] " + ln });
    });
    p.on("close", (code) => {
      if (killed) return;
      const exists = fs.existsSync(path.join(target, "CLAUDE.md"));
      if (code === 0 && exists) {
        send("status", { phase: "claude-init", message: "CLAUDE.md gerado pelo Claude /init" });
        resolve(true);
      } else {
        resolve(false);
      }
    });
    p.on("error", () => resolve(false));
    // Hard timeout 3 min
    setTimeout(() => { killed = true; try { p.kill("SIGTERM"); } catch {} resolve(false); }, 180000);
  });
}

// Render a project-local CLAUDE.md tailored to kind/template/stack.
function renderProjectClaudeMd({ name, description, kind, stack, bmad, template }) {
  const kindLabel = {
    web: "Web app", cli: "CLI", lib: "Biblioteca", api: "API / backend",
    data: "Data / ML", mobile: "Mobile", other: "Projeto",
  }[kind] || "Projeto";

  let stackBlock = "";
  if (kind === "web" && (template === "vite-shadcn" || !template || template === "vite-blank")) {
    stackBlock = `
## Stack

- Vite + React + TypeScript + Tailwind${template === "vite-blank" ? "" : " + shadcn/ui"}
- Path alias: \`@/\` → \`./src/\`
${template !== "vite-blank" ? "- Componentes shadcn em `src/components/ui/` (Button, Card, Input)\n- Tema com CSS variables HSL (light/dark)" : ""}
`;
  } else if (kind === "web" && template === "nextjs") {
    stackBlock = `
## Stack

- Next.js 15 (App Router) + TypeScript + Tailwind
- Pages em \`src/app/<rota>/page.tsx\`
- Path alias: \`@/\` → \`./src/\`
`;
  } else if (kind === "cli") {
    stackBlock = `
## Stack

- Node + TypeScript + tsx (\`npm run dev\` usa tsx pra rodar TS direto)
- CLI parser: commander
- Entry: \`src/cli.ts\`
- Build: \`tsc\` → \`dist/cli.js\` (declarado em \`bin\`)
`;
  } else if (kind === "api") {
    stackBlock = `
## Stack

- Node + TypeScript + Express + tsx watch
- Entry: \`src/server.ts\`
- Porta: \`process.env.PORT\` ou 3000
- CORS habilitado
`;
  } else if (kind === "lib") {
    stackBlock = `
## Stack

- TypeScript + tsup (output ESM + CJS + .d.ts)
- Entry: \`src/index.ts\`
- Build: \`npm run build\` → \`dist/\`
`;
  } else if (stack && stack.length) {
    stackBlock = `\n## Stack\n\n- ${stack.join("\n- ")}\n`;
  }

  let commandsBlock = "";
  if (kind === "web" || kind === "api" || kind === "lib") {
    const cmds = [];
    cmds.push("- `npm run dev` — modo desenvolvimento (hot reload)");
    if (kind === "web" || kind === "lib") cmds.push("- `npm run build` — build de produção");
    if (kind === "lib") cmds.push("- `npm run type-check` — só typecheck (sem emit)");
    if (kind === "api") cmds.push("- `npm start` — roda build em produção");
    if (kind === "web" && template === "nextjs") cmds.push("- `npm run lint` — eslint do Next");
    commandsBlock = `\n## Comandos\n\n${cmds.join("\n")}\n`;
  } else if (kind === "cli") {
    commandsBlock = `\n## Comandos\n\n- \`npm run dev\` — roda direto via tsx (sem build)\n- \`npm run build\` — gera \`dist/cli.js\`\n- \`npm start\` — roda \`dist/cli.js\`\n- \`./dist/cli.js hello <nome>\` — exemplo do command "hello"\n`;
  }

  let bmadBlock = "";
  if (bmad) {
    bmadBlock = `
## BMAD instalado

\`_bmad/\` contém os agentes BMAD (analyst/pm/architect/designer/dev/qa/sm). Pra rodar via Nook Studio: ative o projeto em **Code mode** e use o botão \`🤖 BMAD ▾\` no project bar — gera artefatos em \`docs/<agent>.md\`.
`;
  }

  const projectStructure = (() => {
    if (kind === "web" && template === "nextjs") {
      return `- \`src/app/\` — App Router (layout.tsx, page.tsx, route handlers)
- \`src/app/globals.css\` — Tailwind imports
- \`docs/\` — PRD, arquitetura, brief (BMAD)
- \`scripts/\` — scripts auxiliares`;
    }
    if (kind === "web") {
      return `- \`src/\` — código fonte (App.tsx, main.tsx, components, lib)
- \`src/components/ui/\` — componentes shadcn (Button, Card, Input)
- \`docs/\` — PRD, arquitetura, brief (BMAD)
- \`public/\` — assets estáticos servidos pelo Vite
- \`scripts/\` — scripts auxiliares`;
    }
    return `- \`src/\` — código fonte
- \`docs/\` — PRD, arquitetura, brief (BMAD)
- \`scripts/\` — scripts auxiliares`;
  })();

  const builderBlock = kind === "web" ? `
## Builder (Nook Studio)

Este projeto pode ter páginas visuais editadas no **Builder** do Nook Studio (modo Code → \`🧱 Builder\` ou Ctrl+B).

Pages ficam em \`nook-pages/<nome>.page.json\`. Duas formas de consumir:

- **Export to JSX** (\`📤 Export\`) — gera \`src/nook-pages/<nome>.tsx\` (ou \`src/app/<nome>/page.tsx\` no Next.js). Componente React real, edição manual sobrescrita no próximo Export.
- **Install Runtime** (\`📥 Runtime\`) — copia \`src/components/JBuilderPage.tsx\` que renderiza \`.page.json\` em runtime. Live binding: edita no Builder, salva, app atualiza.

Pages têm formato: \`{ name, root: { id, type, props, children, events } }\`. 14 tipos suportados (Container/Card/Section/Heading/H2/H3/Text/Link/Button/Input/Image/Divider/Badge/Avatar). Workflows de eventos: alert/log/navigate/setState/fetch.
` : "";

  const dbBlock = [
    "## Banco de dados",
    "",
    "Banco deste projeto = **Supabase** (Postgres + Studio + Auth/Storage/Realtime), provisionado pelo Nook Studio. **SQLite é proibido** aqui (`node:sqlite`, `better-sqlite3`, `sql.js`, `.db`) e **não use Drizzle nem `pg` direto** — o acesso é via **`@supabase/supabase-js`**. (Quem usa SQLite é só o repo do Hub, não este projeto.)",
    "",
    "- **Provisionar** (roda `supabase init`, sobe o Supabase local do projeto e escreve as keys no `.env`): clique no botão **🗄️ Banco** no Code mode, ou rode (use o **diretório-raiz** deste projeto, onde está o `package.json`):",
    "  `curl -s -X POST http://localhost:3000/api/code/db/provision -H 'Content-Type: application/json' -d '{\"path\":\"<dir absoluto deste projeto>\"}'`",
    "  Adiciona `@supabase/supabase-js`, gera `lib/supabase.ts` e cria `supabase/` (config + migrations). Confira `{\"ok\":true}`.",
    "- **No código:** importe `supabase` de `lib/supabase.ts` (lê `SUPABASE_URL`/`SUPABASE_ANON_KEY` do ambiente — o `.env` é preenchido no provisionamento). **Nunca hardcode** URL nem keys.",
    "- **Ferramentas = Supabase MCP** (no `.mcp.json` do projeto, ligado após o provision). PREFIRA as tools dele: `apply_migration` pra mudança de schema (vira migration reproduzível), `execute_sql` pra query, `list_tables`, `generate_typescript_types`, `get_logs`, `get_advisors`. Use `apply_migration` (não `execute_sql`) pra DDL.",
    "- **Schema = migrations SQL do Supabase** (fonte oficial em `supabase/migrations/`). NÃO altere tabelas na mão pelo Studio (é sobrescrito). FALLBACK sem MCP, via Hub:",
    "  - nova migration: `curl -s -X POST http://localhost:3000/api/code/db/generate -H 'Content-Type: application/json' -d '{\"path\":\"<dir>\",\"name\":\"cria_tabela_x\"}'` (cria o arquivo SQL; escreva o DDL nele)",
    "  - capturar do Studio: `curl -s -X POST http://localhost:3000/api/code/db/diff -H 'Content-Type: application/json' -d '{\"path\":\"<dir>\",\"name\":\"<mudança>\"}'` (se o usuário criou tabelas VISUAL no Studio: gera a migration do diff sozinho)",
    "  - aplicar no dev: `curl -s -X POST http://localhost:3000/api/code/db/migrate -H 'Content-Type: application/json' -d '{\"path\":\"<dir>\"}'`",
    "  - promover pro prod (projeto Supabase linkado): `curl -s -X POST http://localhost:3000/api/code/db/promote -H 'Content-Type: application/json' -d '{\"path\":\"<dir>\"}'`",
    "  - status/keys: `curl -s 'http://localhost:3000/api/code/db/status?path=<dir>'`",
    "- **Inspeção dos dados = Supabase Studio** (não há tela interna): `POST /api/code/db/studio` com `{\"path\":\"<dir>\"}` devolve a URL do Studio.",
    "- **Tempo real** (front atualiza ao vivo, sem reload): habilite a tabela no publication via migration (`alter publication supabase_realtime add table public.<tabela>;`) e, no front, assine com `supabase.channel('x').on('postgres_changes', { event:'*', schema:'public', table:'<tabela>' }, () => refetch()).subscribe()`. Use as keys `VITE_*`/`NEXT_PUBLIC_*` (já no `.env`).",
    "- **Migrando de SQLite/Postgres-cru:** rode `/provision`, porte as tabelas pra migrations em `supabase/migrations/`, troque os imports pro `lib/supabase.ts`, e remova o adapter antigo, a dep e os `.db`.",
  ].join("\n");

  return `# CLAUDE.md — ${name}

Instruções pra Claude Code (e outros assistentes IA) trabalhando neste projeto.

## Contexto

**${kindLabel}**${description ? `: ${description}` : ""}.

Criado via Nook Studio${bmad ? " com BMAD instalado" : ""}. Metadata em \`.nook-project.json\`.
${stackBlock}${commandsBlock}
## Estrutura

${projectStructure}
${bmadBlock}${builderBlock}
${dbBlock}

## Convenções

- **Sem dependências novas sem aval.** Stack atual deve ser preservada.
- **Edite, não crie.** Prefira modificar arquivos existentes a criar novos.
- **Sem comentários narrativos.** Não anote "// fix do bug X" ou "// added for feature Y" — isso é commit/PR.
- **Sem documentação não solicitada.** Não criar \`*.md\` adicionais sem o usuário pedir.
- **Português brasileiro em UI** (textos pro user). Inglês em código (variáveis, identificadores).
- **Path alias**: imports usam \`@/\` (configurado em \`tsconfig.json\` e \`vite.config.ts\`/\`next.config.mjs\`).

## Antes de declarar pronto

- \`npm run build\` (ou \`npm run type-check\`) sem erro
${kind === "web" || kind === "api" || kind === "lib" ? "- Se houver `tests/`: `npm test`" : ""}
- Se mudou UI: descreva o que **não** foi testado no browser

## Anti-padrões

- ❌ Adicionar bundler/framework alternativo sem necessidade
- ❌ "Cleanup" cosmético sem mudança de comportamento (gera diff ruidoso)
- ❌ Reescrever do zero quando refactor pontual basta
- ❌ Criar abstração pra "futuro" — três usos iguais é melhor que abstração prematura
`;
}

// Generic helper: write file and ensure parent dir
function writeProjectFile(target, rel, content) {
  const p = path.join(target, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Stream-spawn helper for npm install / git commit during scaffold
function spawnStreamed(cmd, args, cwd, prefix, send) {
  return new Promise((resolve) => {
    const ch = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    ch.stdout.on("data", c => {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) send("stdout", { line: prefix + line });
      }
    });
    ch.stderr.on("data", c => {
      const lines = c.toString().split("\n");
      for (const ln of lines) if (ln.trim()) send("stderr", { line: prefix + ln });
    });
    ch.on("close", code => {
      if (buf.trim()) send("stdout", { line: prefix + buf });
      resolve(code);
    });
    ch.on("error", e => { send("stderr", { line: prefix + e.message }); resolve(1); });
  });
}

async function scaffoldViteBlank({ name, target, send }) {
  send("status", { phase: "scaffold", message: "Gerando Vite + React + TS + Tailwind (sem shadcn)..." });
  const pkg = {
    name, private: true, version: "0.0.0", type: "module",
    scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview" },
    dependencies: { "react": "^18.3.1", "react-dom": "^18.3.1" },
    devDependencies: {
      "@types/react": "^18.3.18", "@types/react-dom": "^18.3.5",
      "@vitejs/plugin-react": "^4.3.4", "autoprefixer": "^10.4.20",
      "postcss": "^8.4.49", "tailwindcss": "^3.4.17",
      "typescript": "^5.7.2", "vite": "^6.0.3",
    },
  };
  writeProjectFile(target, "package.json", JSON.stringify(pkg, null, 2) + "\n");
  writeProjectFile(target, "index.html",
`<!doctype html>
<html lang="pt-BR">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>${name}</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
`);
  writeProjectFile(target, "vite.config.ts",
`import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
`);
  writeProjectFile(target, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2020", useDefineForClassFields: true,
      lib: ["ES2020", "DOM", "DOM.Iterable"], module: "ESNext",
      skipLibCheck: true, moduleResolution: "bundler",
      allowImportingTsExtensions: true, resolveJsonModule: true,
      isolatedModules: true, noEmit: true, jsx: "react-jsx", strict: true,
      baseUrl: ".", paths: { "@/*": ["./src/*"] },
    },
    include: ["src"],
  }, null, 2) + "\n");
  writeProjectFile(target, "tailwind.config.js",
`/** @type {import('tailwindcss').Config} */
export default { content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"], theme: { extend: {} }, plugins: [] };
`);
  writeProjectFile(target, "postcss.config.js",
`export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
`);
  writeProjectFile(target, "src/main.tsx",
`import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
`);
  writeProjectFile(target, "src/App.tsx",
`export default function App() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold">${name}</h1>
        <p className="mt-2 text-slate-400">Vite + React + TS + Tailwind</p>
      </div>
    </div>
  );
}
`);
  writeProjectFile(target, "src/index.css",
`@tailwind base;
@tailwind components;
@tailwind utilities;
`);
  await spawnStreamed("npm", ["install", "--no-audit", "--no-fund"], target, "[npm] ", send);
  await spawnStreamed("bash", ["-c", "git add -A && git commit -q -m 'scaffold: vite blank' || true"], target, "[git] ", send);
}

async function scaffoldNextjs({ name, target, send }) {
  send("status", { phase: "scaffold", message: "Gerando Next.js (App Router + TS + Tailwind)..." });
  const pkg = {
    name, private: true, version: "0.1.0",
    scripts: { dev: "next dev", build: "next build", start: "next start", lint: "next lint" },
    dependencies: {
      "next": "^15.1.0", "react": "^18.3.1", "react-dom": "^18.3.1",
    },
    devDependencies: {
      "@types/node": "^22.10.2", "@types/react": "^18.3.18", "@types/react-dom": "^18.3.5",
      "autoprefixer": "^10.4.20", "eslint": "^9.17.0", "eslint-config-next": "^15.1.0",
      "postcss": "^8.4.49", "tailwindcss": "^3.4.17", "typescript": "^5.7.2",
    },
  };
  writeProjectFile(target, "package.json", JSON.stringify(pkg, null, 2) + "\n");
  writeProjectFile(target, "next.config.mjs",
`/** @type {import('next').NextConfig} */
const nextConfig = {};
export default nextConfig;
`);
  writeProjectFile(target, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022", lib: ["dom", "dom.iterable", "esnext"],
      allowJs: true, skipLibCheck: true, strict: true, noEmit: true,
      esModuleInterop: true, module: "esnext", moduleResolution: "bundler",
      resolveJsonModule: true, isolatedModules: true, jsx: "preserve",
      incremental: true,
      plugins: [{ name: "next" }],
      paths: { "@/*": ["./src/*"] },
    },
    include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
    exclude: ["node_modules"],
  }, null, 2) + "\n");
  writeProjectFile(target, "tailwind.config.ts",
`import type { Config } from "tailwindcss";
export default {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
`);
  writeProjectFile(target, "postcss.config.mjs",
`export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
`);
  writeProjectFile(target, "src/app/layout.tsx",
`import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "${name}",
  description: "App ${name}",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
`);
  writeProjectFile(target, "src/app/page.tsx",
`export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold">${name}</h1>
        <p className="mt-2 text-slate-400">Next.js + TS + Tailwind</p>
      </div>
    </main>
  );
}
`);
  writeProjectFile(target, "src/app/globals.css",
`@tailwind base;
@tailwind components;
@tailwind utilities;
`);
  writeProjectFile(target, ".eslintrc.json", JSON.stringify({ extends: "next/core-web-vitals" }, null, 2) + "\n");
  writeProjectFile(target, "next-env.d.ts",
`/// <reference types="next" />
/// <reference types="next/image-types/global" />
`);
  await spawnStreamed("npm", ["install", "--no-audit", "--no-fund"], target, "[npm] ", send);
  await spawnStreamed("bash", ["-c", "git add -A && git commit -q -m 'scaffold: next.js (app router + ts + tailwind)' || true"], target, "[git] ", send);
}

async function scaffoldNodeCli({ name, target, send }) {
  send("status", { phase: "scaffold", message: "Gerando template CLI (tsx + commander)..." });
  const pkg = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    bin: { [name]: "./dist/cli.js" },
    scripts: {
      dev: "tsx src/cli.ts",
      build: "tsc",
      start: "node dist/cli.js",
    },
    dependencies: {
      "commander": "^12.1.0",
    },
    devDependencies: {
      "@types/node": "^22.10.2",
      "tsx": "^4.19.2",
      "typescript": "^5.7.2",
    },
  };
  writeProjectFile(target, "package.json", JSON.stringify(pkg, null, 2) + "\n");
  writeProjectFile(target, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      esModuleInterop: true, strict: true, skipLibCheck: true,
      outDir: "dist", rootDir: "src", declaration: false,
      resolveJsonModule: true, isolatedModules: true,
    },
    include: ["src"],
  }, null, 2) + "\n");
  writeProjectFile(target, "src/cli.ts",
`#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("${name}")
  .description("CLI ${name}")
  .version("0.0.0");

program
  .command("hello")
  .description("Diz oi")
  .argument("[nome]", "nome", "mundo")
  .action((nome) => {
    console.log(\`Hello, \${nome}!\`);
  });

program.parse();
`);
  await spawnStreamed("npm", ["install", "--no-audit", "--no-fund"], target, "[npm] ", send);
  await spawnStreamed("bash", ["-c", "git add -A && git commit -q -m 'scaffold: cli (tsx+commander)' || true"], target, "[git] ", send);
}

async function scaffoldNodeApi({ name, target, send }) {
  send("status", { phase: "scaffold", message: "Gerando template API (Express + TS)..." });
  const pkg = {
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "tsx watch src/server.ts",
      build: "tsc",
      start: "node dist/server.js",
    },
    dependencies: {
      "express": "^4.21.2",
      "cors": "^2.8.5",
    },
    devDependencies: {
      "@types/cors": "^2.8.17",
      "@types/express": "^5.0.0",
      "@types/node": "^22.10.2",
      "tsx": "^4.19.2",
      "typescript": "^5.7.2",
    },
  };
  writeProjectFile(target, "package.json", JSON.stringify(pkg, null, 2) + "\n");
  writeProjectFile(target, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      esModuleInterop: true, strict: true, skipLibCheck: true,
      outDir: "dist", rootDir: "src", declaration: false,
      resolveJsonModule: true, isolatedModules: true,
    },
    include: ["src"],
  }, null, 2) + "\n");
  writeProjectFile(target, "src/server.ts",
`import express from "express";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.send("API ${name} no ar"));

app.listen(PORT, () => {
  console.log(\`API ${name} ouvindo em :\${PORT}\`);
});
`);
  await spawnStreamed("npm", ["install", "--no-audit", "--no-fund"], target, "[npm] ", send);
  await spawnStreamed("bash", ["-c", "git add -A && git commit -q -m 'scaffold: api (express+ts)' || true"], target, "[git] ", send);
}

async function scaffoldNodeLib({ name, target, send }) {
  send("status", { phase: "scaffold", message: "Gerando template Lib (tsup + TS)..." });
  const pkg = {
    name,
    version: "0.0.0",
    private: false,
    type: "module",
    main: "./dist/index.cjs",
    module: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
        require: "./dist/index.cjs",
      },
    },
    files: ["dist"],
    scripts: {
      dev: "tsup --watch",
      build: "tsup",
      "type-check": "tsc --noEmit",
    },
    devDependencies: {
      "@types/node": "^22.10.2",
      "tsup": "^8.3.5",
      "typescript": "^5.7.2",
    },
  };
  writeProjectFile(target, "package.json", JSON.stringify(pkg, null, 2) + "\n");
  writeProjectFile(target, "tsconfig.json", JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "bundler",
      esModuleInterop: true, strict: true, skipLibCheck: true,
      declaration: true, declarationMap: true,
      outDir: "dist", rootDir: "src",
      resolveJsonModule: true, isolatedModules: true,
    },
    include: ["src"],
  }, null, 2) + "\n");
  writeProjectFile(target, "tsup.config.ts",
`import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
});
`);
  writeProjectFile(target, "src/index.ts",
`export function hello(nome: string = "mundo"): string {
  return \`Hello, \${nome}!\`;
}
`);
  await spawnStreamed("npm", ["install", "--no-audit", "--no-fund"], target, "[npm] ", send);
  await spawnStreamed("bash", ["-c", "git add -A && git commit -q -m 'scaffold: lib (tsup+ts)' || true"], target, "[git] ", send);
}

// Post-newproj: write project metadata, hub note, populated README, and optionally run Analyst.
async function postCreateEnrichProject({ name, target, description, kind, stack, bmad, hubNote, runAnalyst, template, source, send }) {
  const today = new Date().toISOString().slice(0, 10);
  const isImport = source === "local" || source === "github";
  // 0) Kind-specific scaffolding (skipped for imports — user brought their own files)
  try {
    if (isImport) {
      send("status", { phase: "scaffold", message: "Pulando scaffold (origem: " + source + ")" });
      const pkgPath = path.join(target, "package.json");
      const nmPath = path.join(target, "node_modules");
      if (fs.existsSync(pkgPath) && !fs.existsSync(nmPath)) {
        send("status", { phase: "install", message: "Rodando npm install (pode levar 30-60s)..." });
        const code = await spawnStreamed("npm", ["install", "--no-audit", "--no-fund"], target, "[npm] ", send);
        if (code !== 0) send("stderr", { line: "[npm] install falhou (exit " + code + ") — rode manualmente" });
        else send("status", { phase: "install", message: "npm install concluido" });
      }
    } else if (kind === "web" || kind === "design-system") {
      const t = template || "vite-shadcn";
      if (t === "vite-blank") await scaffoldViteBlank({ name, target, send });
      else if (t === "nextjs") await scaffoldNextjs({ name, target, send });
      else await scaffoldViteReact({ name, target, send });
    }
    else if (kind === "cli") await scaffoldNodeCli({ name, target, send });
    else if (kind === "api") await scaffoldNodeApi({ name, target, send });
    else if (kind === "lib") await scaffoldNodeLib({ name, target, send });
  } catch (e) { send("stderr", { line: "[scaffold] " + e.message }); }
  // 0.5) Inject Nook preview helpers (picker + runtime-error capture) into index.html
  try {
    if (injectNookScripts(target)) {
      send("status", { phase: "picker", message: "nook-picker.js + nook-errors.js injetados em index.html" });
    }
  } catch (e) { send("stderr", { line: "[picker] " + e.message }); }
  // 1) .nook-project.json — read by code-mode systemPrompt to inject context
  try {
    const meta = { name, kind, description, stack, bmad, createdAt: today, hubNote: hubNote ? `projetos/${name}.md` : null };
    if (kind === "design-system") {
      meta.syncPaths = ["src/components/ui", "src/components/shared", "src/styles", "src/lib", "src/index.css", "tailwind.config.js", "tailwind.config.ts", "postcss.config.js", "components.json"];
    }
    fs.writeFileSync(path.join(target, ".nook-project.json"), JSON.stringify(meta, null, 2));
    send("status", { phase: "meta", message: "Metadata gravada em .nook-project.json" });
  } catch (e) {
    send("stderr", { line: "[meta] " + e.message });
  }

  // 1.5) Write CLAUDE.md — prefer `claude /init` (Anthropic-canonical), fallback to local template
  try {
    const claudePath = path.join(target, "CLAUDE.md");
    if (!fs.existsSync(claudePath)) {
      const usedClaude = await tryClaudeInit(target, send);
      if (!usedClaude) {
        const claudeMd = renderProjectClaudeMd({ name, description, kind, stack, bmad, template });
        fs.writeFileSync(claudePath, claudeMd);
        send("status", { phase: "claude", message: "CLAUDE.md (template Nook) gravado — claude CLI não rodou" });
      }
    }
  } catch (e) {
    send("stderr", { line: "[claude] " + e.message });
  }

  // 2) Populate README.md — replace empty placeholders left by newproj
  if (description || stack.length) {
    try {
      const readmePath = path.join(target, "README.md");
      let readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, "utf8") : `# ${name}\n\n## Objetivo\n\n\n## Stack\n\n\n`;
      // Fill ## Objetivo placeholder (empty body before next ## or EOF)
      if (description) {
        readme = readme.replace(/(^## Objetivo\s*\n)\s*\n(?=##|$)/m, `$1\n${description}\n\n`);
      }
      // Fill ## Stack placeholder
      if (stack.length) {
        readme = readme.replace(/(^## Stack\s*\n)\s*\n(?=##|$)/m, `$1\n- ${stack.join("\n- ")}\n\n`);
      }
      // Add ## Tipo before ## Estrutura if present, else at end
      if (!/^## Tipo/m.test(readme)) {
        if (/^## Estrutura/m.test(readme)) {
          readme = readme.replace(/^(## Estrutura)/m, `## Tipo\n\n${kind}\n\n$1`);
        } else {
          readme = readme.trimEnd() + `\n\n## Tipo\n\n${kind}\n`;
        }
      }
      fs.writeFileSync(readmePath, readme);
      send("status", { phase: "readme", message: "README.md populado" });
    } catch (e) {
      send("stderr", { line: "[readme] " + e.message });
    }
  }

  // 3) Hub note in _hub/projetos/<name>.md
  if (hubNote) {
    try {
      const projetosDir = path.join(HUB_ROOT, "projetos");
      fs.mkdirSync(projetosDir, { recursive: true });
      const notePath = path.join(projetosDir, `${name}.md`);
      const tags = ["projeto", kind, ...stack.map(s => s.toLowerCase().replace(/\s+/g, "-"))]
        .filter(Boolean);
      const fm = [
        "---",
        `tipo: ${kind}`,
        `stack: [${stack.join(", ")}]`,
        `criado: ${today}`,
        `caminho: ~/dev/projetos/${name}`,
        `bmad: ${bmad}`,
        `tags: [${tags.join(", ")}]`,
        "---",
        "",
      ].join("\n");
      const sections = [];
      if (description) sections.push(`## Objetivo\n\n${description}`);
      if (stack.length) sections.push(`## Stack\n\n- ${stack.join("\n- ")}`);
      const caminho = [
        `- Codigo: \`~/dev/projetos/${name}\``,
        `- README: \`~/dev/projetos/${name}/README.md\``,
      ];
      if (bmad) caminho.push(`- BMAD: \`~/dev/projetos/${name}/.bmad/\``);
      if (runAnalyst) caminho.push(`- Brief: [[brief-${name}]]`);
      sections.push(`## Caminho\n\n${caminho.join("\n")}`);
      sections.push("## Notas\n\n");
      sections.push("## Links\n\n[[index]]");
      const body = `# ${name}\n\n` + sections.join("\n\n") + "\n";
      if (!fs.existsSync(notePath)) {
        fs.writeFileSync(notePath, fm + body);
        send("status", { phase: "hub", message: `Nota Obsidian criada: _hub/projetos/${name}.md` });
      } else {
        send("stderr", { line: `[hub] _hub/projetos/${name}.md ja existe, mantendo` });
      }
      // newproj already appends a line to index.md; only enrich if description exists and the existing line lacks one
      const indexPath = path.join(projetosDir, "index.md");
      if (fs.existsSync(indexPath) && description) {
        const cur = fs.readFileSync(indexPath, "utf8");
        const re = new RegExp(`^(- \\[\\[\\.\\.\\/\\.\\.\\/projetos\\/${name}\\/README\\|${name}\\]\\][^\\n]*)$`, "m");
        const m = cur.match(re);
        if (m && !m[1].includes(" — ")) {
          const enriched = m[1] + " — " + description.slice(0, 80);
          fs.writeFileSync(indexPath, cur.replace(re, enriched));
        }
      }
    } catch (e) {
      send("stderr", { line: "[hub] " + e.message });
    }
  }

  // 4) Run Analyst (Mary) and save docs/brief.md
  if (runAnalyst && description) {
    send("status", { phase: "analyst", message: "Disparando Analyst (Mary)..." });
    try {
      let briefMd = await runAnalystForProject({ name, description, kind, stack, send });
      // Strip wrapper code-fence if the model returned the whole brief inside ```markdown ... ```
      if (briefMd) {
        briefMd = briefMd.trim();
        const fence = briefMd.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
        if (fence) briefMd = fence[1].trim();
      }
      if (briefMd) {
        const docsDir = path.join(target, "docs");
        fs.mkdirSync(docsDir, { recursive: true });
        const briefPath = path.join(docsDir, "brief.md");
        fs.writeFileSync(briefPath, briefMd);
        send("status", { phase: "analyst", message: "Brief gravado em docs/brief.md" });
        // Optional: copy brief into hub as brief-<name>.md
        if (hubNote) {
          try {
            const hubBrief = path.join(HUB_ROOT, "projetos", `brief-${name}.md`);
            const fm = `---\ntipo: brief\nprojeto: ${name}\ncriado: ${today}\ntags: [brief, projeto]\n---\n\n`;
            fs.writeFileSync(hubBrief, fm + briefMd);
          } catch {}
        }
      }
    } catch (e) {
      send("stderr", { line: "[analyst] " + e.message });
    }
  }
}

// Catalog of BMAD agents and their canonical artifacts.
const BMAD_AGENT_TASKS = {
  analyst: {
    file: "brief.md",
    label: "Mary (Analyst)",
    prompt: ({ name, description, kind, stack }) =>
      `Projeto: ${name}\nTipo: ${kind}\nStack: ${stack.join(", ") || "(nao definida)"}\n\n` +
      `Descricao do dono:\n${description}\n\n` +
      `Tarefa: produza um project brief curto e direto em Markdown com as secoes: ` +
      `Visao, Problema, Usuarios, Escopo MVP, Fora de escopo, Riscos, Proximos passos. ` +
      `Sem floreios, em portugues.`,
  },
  pm: {
    file: "prd.md",
    label: "John (PM)",
    prompt: ({ name, description, kind, stack, brief }) =>
      `Projeto: ${name}\nTipo: ${kind}\nStack: ${stack.join(", ") || "(nao definida)"}\n\n` +
      `Descricao:\n${description}\n` +
      (brief ? `\nBrief existente:\n${brief}\n` : "") +
      `\nTarefa: elabore um PRD em Markdown com: Objetivo, Personas, Fluxos principais, Requisitos funcionais, Requisitos nao-funcionais, KPIs/sucesso, Roadmap por release. Em portugues, direto.`,
  },
  architect: {
    file: "architecture.md",
    label: "Winston (Architect)",
    prompt: ({ name, description, kind, stack, brief }) =>
      `Projeto: ${name}\nTipo: ${kind}\nStack atual: ${stack.join(", ") || "(nao definida)"}\n\n` +
      `Descricao:\n${description}\n` +
      (brief ? `\nBrief:\n${brief}\n` : "") +
      `\nTarefa: documento de arquitetura em Markdown com: Visao geral, Componentes, Fluxo de dados, Decisoes-chave (com justificativa), Stack final recomendada, Modelo de dados, Trade-offs. Em portugues, direto.`,
  },
  designer: {
    file: "design.md",
    label: "Sally (Designer)",
    prompt: ({ name, description, kind, stack, brief }) =>
      `Projeto: ${name}\nTipo: ${kind}\nStack: ${stack.join(", ") || "(nao definida)"}\n\n` +
      `Descricao:\n${description}\n` +
      (brief ? `\nBrief:\n${brief}\n` : "") +
      `\nTarefa: design doc em Markdown com: Telas principais (descricao + componentes), Fluxos de UX, Sistema de tipografia/cor/espacamento, Padroes de componentes (shadcn ja instalado), Acessibilidade. Densidade > floreios. Em portugues.`,
  },
  dev: {
    file: "dev-plan.md",
    label: "James (Dev)",
    prompt: ({ name, description, kind, stack, brief }) =>
      `Projeto: ${name}\nTipo: ${kind}\nStack: ${stack.join(", ") || "(nao definida)"}\n\n` +
      `Descricao:\n${description}\n` +
      (brief ? `\nBrief:\n${brief}\n` : "") +
      `\nTarefa: plano de implementacao em Markdown com: Tarefas tecnicas ordenadas, Estrutura de pastas, Padroes de codigo, Setup local (passos), Riscos tecnicos. Em portugues, direto.`,
  },
  qa: {
    file: "qa-plan.md",
    label: "Quinn (QA)",
    prompt: ({ name, description, kind, stack, brief }) =>
      `Projeto: ${name}\nTipo: ${kind}\nStack: ${stack.join(", ") || "(nao definida)"}\n\n` +
      `Descricao:\n${description}\n` +
      (brief ? `\nBrief:\n${brief}\n` : "") +
      `\nTarefa: plano de QA em Markdown com: Estrategia de testes, Casos criticos (caminho feliz + edge), Cenarios de regressao, Ferramentas (vitest/playwright/etc), Definicao de "pronto". Em portugues.`,
  },
  sm: {
    file: "sprint-1.md",
    label: "Bob (SM)",
    prompt: ({ name, description, kind, stack, brief }) =>
      `Projeto: ${name}\nTipo: ${kind}\nStack: ${stack.join(", ") || "(nao definida)"}\n\n` +
      `Descricao:\n${description}\n` +
      (brief ? `\nBrief:\n${brief}\n` : "") +
      `\nTarefa: plano de sprint 1 em Markdown com: Objetivo do sprint, User stories priorizadas (formato "Como X quero Y para Z"), Criterios de aceite por story, Estimativa relativa (T-shirt sizing), Definicao de pronto. Em portugues.`,
  },
};

// Stream from sidecar /chat with a BMAD agent, return concatenated text.
function runBmadAgentChat({ agent, prompt, projectName, send }) {
  return new Promise((resolve, reject) => {
    const body = { agent, mode: "codigo", prompt };
    if (projectName) body.projeto = projectName;
    const payload = JSON.stringify(body);
    const opts = {
      hostname: "127.0.0.1",
      port: CORE_PORT,
      path: "/chat",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    };
    const r = http.request(opts, (ur) => {
      let buf = "";
      let out = "";
      ur.on("data", chunk => {
        buf += chunk.toString();
        const blocks = buf.split("\n\n");
        buf = blocks.pop();
        for (const blk of blocks) {
          const m = blk.match(/^data:\s*(.+)$/m);
          if (!m) continue;
          let evt;
          try { evt = JSON.parse(m[1]); } catch { continue; }
          if (evt.kind === "token" && evt.text) {
            out += evt.text;
            send("token", { agent, text: evt.text });
          }
          if (evt.kind === "tool") {
            send("tool", { agent, name: evt.name });
            send("stdout", { line: `[${agent} tool] ${evt.name}` });
          }
        }
      });
      ur.on("end", () => resolve(out.trim()));
    });
    r.on("error", reject);
    r.setTimeout(180000, () => { r.destroy(new Error(agent + " timeout")); });
    r.write(payload);
    r.end();
  });
}

function stripMarkdownFence(s) {
  if (!s) return s;
  s = s.trim();
  const m = s.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1].trim() : s;
}

// Backward-compat for createProject's runAnalyst flow
async function runAnalystForProject({ name, description, kind, stack, send }) {
  const out = await runBmadAgentChat({
    agent: "analyst",
    prompt: BMAD_AGENT_TASKS.analyst.prompt({ name, description, kind, stack }),
    projectName: name,
    send,
  });
  return stripMarkdownFence(out);
}

// Run any BMAD agent for an existing project; saves to docs/<file> and hub.
async function runBmadAgentForExistingProject({ projectPath, agentName, send }) {
  const safe = _safeProjectPath(projectPath);
  if (!safe) throw new Error("Caminho invalido");
  const cfg = BMAD_AGENT_TASKS[agentName];
  if (!cfg) throw new Error("Agente desconhecido: " + agentName);

  // Load metadata
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(safe, ".nook-project.json"), "utf8")); }
  catch { /* ok, fields default to empty */ }
  const name = meta.name || path.basename(safe);
  const description = meta.description || "";
  const kind = meta.kind || "other";
  const stack = Array.isArray(meta.stack) ? meta.stack : [];

  // Load brief if exists for additional context
  let brief = "";
  try {
    const briefPath = path.join(safe, "docs", "brief.md");
    if (fs.existsSync(briefPath)) brief = fs.readFileSync(briefPath, "utf8");
  } catch {}

  send("status", { phase: agentName, message: `Disparando ${cfg.label}...` });
  const raw = await runBmadAgentChat({
    agent: agentName,
    prompt: cfg.prompt({ name, description, kind, stack, brief }),
    projectName: name,
    send,
  });
  const md = stripMarkdownFence(raw);
  if (!md) throw new Error("Sem output do agente");

  // Save to docs/
  const docsDir = path.join(safe, "docs");
  fs.mkdirSync(docsDir, { recursive: true });
  const outPath = path.join(docsDir, cfg.file);
  fs.writeFileSync(outPath, md);
  send("status", { phase: agentName, message: `Salvo em docs/${cfg.file}` });

  // Mirror to hub if hubNote exists
  try {
    if (meta.hubNote) {
      const today = new Date().toISOString().slice(0, 10);
      const hubFile = path.join(HUB_ROOT, "projetos", `${agentName}-${name}.md`);
      const fm = `---\ntipo: ${agentName}\nprojeto: ${name}\ncriado: ${today}\ntags: [${agentName}, projeto]\n---\n\n`;
      fs.writeFileSync(hubFile, fm + md);

      // Append link in main hub note (if Caminho section exists)
      const noteFile = path.join(HUB_ROOT, meta.hubNote);
      if (fs.existsSync(noteFile)) {
        let txt = fs.readFileSync(noteFile, "utf8");
        const link = `- ${cfg.label}: [[${agentName}-${name}]]`;
        if (!txt.includes(`[[${agentName}-${name}]]`)) {
          if (/^## Caminho/m.test(txt)) {
            txt = txt.replace(/(^## Caminho[\s\S]*?)(\n## |\n*$)/m, (full, p1, p2) => p1.trimEnd() + "\n" + link + p2);
          } else {
            txt = txt.trimEnd() + "\n" + link + "\n";
          }
          fs.writeFileSync(noteFile, txt);
        }
      }
    }
  } catch (e) { send("stderr", { line: "[hub] " + e.message }); }

  return { ok: true, file: `docs/${cfg.file}`, path: outPath, bytes: Buffer.byteLength(md, "utf8") };
}

// ── Dev Servers (per-project npm run dev) ──
const devServers = new Map(); // safeProjectPath -> { proc, pid, port, url, logs[], startedAt, exitCode }

function _safeProjectPath(p) {
  if (!p) return null;
  const r = path.resolve(p);
  if (!r.startsWith(PROJETOS_ROOT + path.sep) && r !== PROJETOS_ROOT) return null;
  return r;
}

// Inject the Nook preview helper scripts (picker + runtime-error capture) into
// a project's index.html if missing. Runs at scaffold and on dev-server start,
// so existing projects get the error-capture used by QA self-heal too.
function injectNookScripts(targetDir) {
  try {
    const idx = path.join(targetDir, "index.html");
    if (!fs.existsSync(idx)) return false;
    let html = fs.readFileSync(idx, "utf8");
    const tags = [];
    if (!html.includes("nook-picker.js")) tags.push('    <script src="http://localhost:3000/nook-picker.js"></script>');
    if (!html.includes("nook-errors.js")) tags.push('    <script src="http://localhost:3000/nook-errors.js"></script>');
    if (tags.length && /<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, tags.join("\n") + "\n  </body>");
      fs.writeFileSync(idx, html);
      return true;
    }
  } catch {}
  return false;
}

function startDevServer(projectPath) {
  const safe = _safeProjectPath(projectPath);
  if (!safe) return { error: "Caminho invalido (so projetos em ~/dev/projetos)" };
  if (!fs.existsSync(path.join(safe, "package.json"))) return { error: "Sem package.json" };
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(safe, "package.json"), "utf8")); }
  catch (e) { return { error: "package.json invalido: " + e.message }; }
  if (!pkg.scripts || !pkg.scripts.dev) return { error: 'Sem script "dev" no package.json' };

  injectNookScripts(safe); // retroativo: garante picker+errors no index.html antes do Vite servir

  const existing = devServers.get(safe);
  if (existing && existing.proc) return { ok: true, message: "ja rodando", state: getDevServerState(safe) };

  // O dev server (Vite/Next) carrega o .env do projeto sozinho — SUPABASE_URL e as
  // keys são escritas no provisionamento. Sem injeção de credencial aqui.
  const devEnv = { ...process.env, FORCE_COLOR: "0", BROWSER: "none", NODE_ENV: "development" };
  // Full-stack: se há "dev:all" (ex: concurrently api+web), roda ele pra subir o
  // backend junto — senão a API do projeto nunca sobe e o app fica só no localStorage.
  const devScript = (pkg.scripts && pkg.scripts["dev:all"]) ? "dev:all" : "dev";
  const proc = spawn("npm", ["run", devScript], {
    cwd: safe,
    stdio: ["ignore", "pipe", "pipe"],
    env: devEnv,
  });
  const state = { proc, pid: proc.pid, port: null, url: null, logs: [], startedAt: Date.now(), exitCode: null };
  devServers.set(safe, state);

  const onLine = (line) => {
    if (state.logs.length >= 200) state.logs.shift();
    state.logs.push(line);
    {
      // Vite/Next: "Local:   http://localhost:5173/". Com dev:all (api+web), a API
      // pode logar a URL antes — preferimos a linha "Local:" (o web app) e travamos
      // nela, pro preview não apontar pro backend (ex: :3333).
      const m = line.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/);
      if (m) {
        const fromMarker = /\bLocal:/i.test(line);
        if (!state.url || (fromMarker && !state._urlMarker)) {
          state.port = Number(m[1]);
          state.url = "http://localhost:" + state.port;
          if (fromMarker) state._urlMarker = true;
        }
      }
    }
  };

  let buf = "";
  proc.stdout.on("data", c => {
    buf += c.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).replace(/\[[0-9;]*m/g, "");
      buf = buf.slice(nl + 1);
      if (line.trim()) onLine(line);
    }
  });
  proc.stderr.on("data", c => {
    const s = c.toString().replace(/\[[0-9;]*m/g, "");
    for (const ln of s.split("\n")) if (ln.trim()) onLine(ln);
  });
  proc.on("close", (code) => {
    state.proc = null;
    state.exitCode = code;
  });
  proc.on("error", (e) => {
    state.proc = null;
    onLine("[error] " + e.message);
  });

  return { ok: true, state: getDevServerState(safe) };
}

function getDevServerState(projectPath) {
  const safe = _safeProjectPath(projectPath);
  if (!safe) return { running: false };
  const s = devServers.get(safe);
  if (!s) return { running: false };
  return {
    running: !!s.proc,
    pid: s.pid,
    port: s.port,
    url: s.url,
    startedAt: s.startedAt,
    exitCode: s.exitCode,
    logsCount: s.logs.length,
  };
}

function stopDevServer(projectPath) {
  const safe = _safeProjectPath(projectPath);
  if (!safe) return { error: "Caminho invalido" };
  const s = devServers.get(safe);
  if (!s || !s.proc) return { ok: true, message: "nao estava rodando" };
  try {
    s.proc.kill("SIGTERM");
    const proc = s.proc;
    setTimeout(() => { try { if (proc && !proc.killed) proc.kill("SIGKILL"); } catch {} }, 3000);
    s.proc = null;
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
}

function getDevServerLogs(projectPath, max) {
  const safe = _safeProjectPath(projectPath);
  if (!safe) return [];
  const s = devServers.get(safe);
  if (!s) return [];
  const n = Math.max(1, Math.min(200, Number(max) || 50));
  return s.logs.slice(-n);
}

// ── Folder picker for "Pasta local" in New Project modal ──
function listDirsForPicker(rawPath, res) {
  const resolved = path.resolve(rawPath || "/home/diogo");
  if (!resolved.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Fora de /home/diogo" }));
  }
  if (!fs.existsSync(resolved)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Nao existe" }));
  }
  let stat;
  try { stat = fs.statSync(resolved); } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: e.message }));
  }
  if (!stat.isDirectory()) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Nao e diretorio" }));
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(resolved, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, hidden: e.name.startsWith(".") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Sem permissao: " + e.message }));
  }
  const parent = (resolved === "/home/diogo" || resolved === "/") ? null : path.dirname(resolved);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ path: resolved, parent, dirs }));
}

// ── Design System: scan ~/dev/projetos/ for kind=design-system, link/sync ──
function readProjectMeta(projDir) {
  try {
    const p = path.join(projDir, ".nook-project.json");
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch { return null; }
}
function writeProjectMeta(projDir, meta) {
  fs.writeFileSync(path.join(projDir, ".nook-project.json"), JSON.stringify(meta, null, 2));
}

function listDesignSystems(res) {
  const out = [];
  try {
    if (fs.existsSync(PROJETOS_ROOT)) {
      for (const e of fs.readdirSync(PROJETOS_ROOT, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const dir = path.join(PROJETOS_ROOT, e.name);
        const meta = readProjectMeta(dir);
        if (meta && meta.kind === "design-system") {
          out.push({
            name: meta.name || e.name,
            path: dir,
            description: meta.description || "",
            syncPaths: Array.isArray(meta.syncPaths) && meta.syncPaths.length ? meta.syncPaths : ["src/components/ui", "src/components/shared", "src/styles", "src/lib", "src/index.css", "tailwind.config.js", "tailwind.config.ts", "postcss.config.js", "components.json"],
          });
        }
      }
    }
  } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ designSystems: out }));
}

function _safeProjectPath(p) {
  if (!p || typeof p !== "string") return null;
  const r = path.resolve(p);
  return r.startsWith(PROJETOS_ROOT + path.sep) || r === PROJETOS_ROOT ? r : null;
}

function _copyDsPaths(dsDir, targetDir, syncPaths) {
  const copied = [], skipped = [];
  for (const rel of syncPaths) {
    const from = path.join(dsDir, rel);
    const to = path.join(targetDir, rel);
    if (!fs.existsSync(from)) { skipped.push(rel); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      // Use cp -r for recursive copy preserving content (no-preserve=ownership)
      const r = require("child_process").spawnSync("cp", ["-r", "--no-preserve=ownership", from + "/.", to + "/"], { stdio: "ignore" });
      if (r.status === 0) copied.push(rel);
      else skipped.push(rel);
    } else {
      try { fs.copyFileSync(from, to); copied.push(rel); }
      catch { skipped.push(rel); }
    }
  }
  return { copied, skipped };
}

function _gitShaSync(dir) {
  try {
    const r = require("child_process").spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    if (r.status === 0) return r.stdout.toString().trim();
  } catch {}
  return null;
}

// Read package.json `dependencies` (only — devDeps are build tools).
function _readPkgDeps(dir) {
  try {
    const p = path.join(dir, "package.json");
    if (!fs.existsSync(p)) return {};
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    return pkg.dependencies || {};
  } catch { return {}; }
}

// Compute which DS runtime deps the target is missing. Returns array of "name@range".
function _missingDeps(targetDir, dsDir) {
  const dsDeps = _readPkgDeps(dsDir);
  const targetDeps = _readPkgDeps(targetDir);
  const out = [];
  for (const [name, range] of Object.entries(dsDeps)) {
    // Don't try to upgrade react/react-dom — peer-dep area, leave to user
    if (name === "react" || name === "react-dom") continue;
    if (!targetDeps[name]) out.push(name + "@" + range);
  }
  return out;
}

// Async install of missing deps via npm. Returns {installed:[], skipped:[], error}.
function _installMissingDeps(targetDir, deps) {
  return new Promise(resolve => {
    if (!deps.length) return resolve({ installed: [], skipped: [], error: null });
    const ch = spawn("npm", ["install", "--no-audit", "--no-fund", "--save", ...deps], {
      cwd: targetDir, stdio: ["ignore", "pipe", "pipe"], timeout: 180000,
    });
    let err = "";
    ch.stderr.on("data", c => err += c.toString());
    ch.stdout.on("data", () => {});
    ch.on("close", code => {
      if (code === 0) resolve({ installed: deps, skipped: [], error: null });
      else resolve({ installed: [], skipped: deps, error: err.slice(-400) || ("exit " + code) });
    });
    ch.on("error", e => resolve({ installed: [], skipped: deps, error: e.message }));
  });
}

async function linkDesignSystem(targetRaw, dsRaw, res) {
  const target = _safeProjectPath(targetRaw);
  const dsPath = _safeProjectPath(dsRaw);
  if (!target || !dsPath) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Caminho fora de ~/dev/projetos" })); }
  if (target === dsPath) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Nao pode vincular projeto a ele mesmo" })); }
  const targetMeta = readProjectMeta(target);
  const dsMeta = readProjectMeta(dsPath);
  if (!targetMeta || !dsMeta) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: ".nook-project.json nao encontrado em um dos projetos" })); }
  if (dsMeta.kind !== "design-system") { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Projeto vinculado nao eh design-system" })); }
  const syncPaths = Array.isArray(dsMeta.syncPaths) && dsMeta.syncPaths.length ? dsMeta.syncPaths : ["src/components/ui", "src/styles", "tailwind.config.js", "tailwind.config.ts", "postcss.config.js", "components.json"];
  const { copied, skipped } = _copyDsPaths(dsPath, target, syncPaths);
  const sha = _gitShaSync(dsPath);
  // Install missing runtime deps from the DS into the target
  const missing = _missingDeps(target, dsPath);
  const depsResult = await _installMissingDeps(target, missing);
  targetMeta.designSystem = {
    projectPath: dsPath,
    name: dsMeta.name || path.basename(dsPath),
    syncPaths,
    lastSyncAt: new Date().toISOString(),
    lastSyncSha: sha,
  };
  writeProjectMeta(target, targetMeta);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, copied, skipped, lastSyncSha: sha, depsInstalled: depsResult.installed, depsError: depsResult.error }));
}

async function syncDesignSystem(targetRaw, res) {
  const target = _safeProjectPath(targetRaw);
  if (!target) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Caminho fora de ~/dev/projetos" })); }
  const meta = readProjectMeta(target);
  if (!meta || !meta.designSystem || !meta.designSystem.projectPath) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Projeto sem DS vinculado" })); }
  const dsPath = meta.designSystem.projectPath;
  const dsMeta = readProjectMeta(dsPath);
  if (!dsMeta) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "DS nao encontrado em " + dsPath })); }
  const syncPaths = Array.isArray(dsMeta.syncPaths) && dsMeta.syncPaths.length ? dsMeta.syncPaths : meta.designSystem.syncPaths;
  const { copied, skipped } = _copyDsPaths(dsPath, target, syncPaths);
  const sha = _gitShaSync(dsPath);
  // Install any new deps the DS now requires
  const missing = _missingDeps(target, dsPath);
  const depsResult = await _installMissingDeps(target, missing);
  meta.designSystem.lastSyncAt = new Date().toISOString();
  meta.designSystem.lastSyncSha = sha;
  meta.designSystem.syncPaths = syncPaths;
  writeProjectMeta(target, meta);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, copied, skipped, lastSyncSha: sha, depsInstalled: depsResult.installed, depsError: depsResult.error }));
}

// Copia um componente do DS pro projeto-alvo seguindo imports relativos
// transitivos. sourceFile vem do data-nook-src do picker no formato
// "src/components/ui/dialog.tsx" ou "src/components/ui/dialog.tsx:42".
async function copyDesignComponent(dsRaw, targetRaw, sourceRaw, res) {
  const dsPath = _safeProjectPath(dsRaw);
  const target = _safeProjectPath(targetRaw);
  if (!dsPath || !target) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Caminho fora de ~/dev/projetos" })); }
  // Strip ":<line>" suffix se vier do data-nook-src
  const sourceFile = String(sourceRaw).split(":")[0].replace(/^\/+/, "");
  const fromAbs = path.join(dsPath, sourceFile);
  if (!fromAbs.startsWith(dsPath + path.sep)) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "sourceFile fora do DS" })); }
  if (!fs.existsSync(fromAbs)) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Arquivo nao encontrado: " + sourceFile })); }

  // BFS pelos imports relativos. Para em deps externas / aliases @ que precisam de resolução custom.
  const queue = [sourceFile];
  const visited = new Set();
  const copied = [];
  const skipped = [];
  const externalImports = new Set();

  while (queue.length) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    visited.add(rel);
    const src = path.join(dsPath, rel);
    if (!fs.existsSync(src)) { skipped.push(rel + " (não existe)"); continue; }
    const dst = path.join(target, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    copied.push(rel);

    // Extract imports from JS/TS/JSX/TSX
    if (!/\.(tsx?|jsx?|mjs|cjs)$/i.test(rel)) continue;
    const code = fs.readFileSync(src, "utf8");
    const importRe = /(?:import|export)\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g;
    let m;
    while ((m = importRe.exec(code))) {
      const spec = m[1];
      if (spec.startsWith(".")) {
        // Relative import: resolve to dsPath
        const resolved = _resolveRelativeImport(path.dirname(src), spec, dsPath);
        if (resolved) queue.push(path.relative(dsPath, resolved));
        else skipped.push(spec + " (não resolveu)");
      } else if (spec.startsWith("@/")) {
        // Alias @ -> src/
        const resolved = _resolveRelativeImport(path.join(dsPath, "src"), "./" + spec.slice(2), dsPath);
        if (resolved) queue.push(path.relative(dsPath, resolved));
        else skipped.push(spec + " (alias não resolveu)");
      } else {
        externalImports.add(spec);
      }
    }
  }

  // Install missing external deps
  const dsDeps = _readPkgDeps(dsPath);
  const targetDeps = _readPkgDeps(target);
  const toInstall = [];
  for (const pkg of externalImports) {
    // Strip subpath: "lucide-react/icons" -> "lucide-react"; "@radix-ui/react-dialog/foo" -> "@radix-ui/react-dialog"
    const base = pkg.startsWith("@") ? pkg.split("/").slice(0, 2).join("/") : pkg.split("/")[0];
    if (base === "react" || base === "react-dom") continue;
    if (targetDeps[base]) continue;
    if (dsDeps[base]) toInstall.push(base + "@" + dsDeps[base]);
    else toInstall.push(base); // version unknown, npm picks latest
  }
  const depsResult = await _installMissingDeps(target, toInstall);

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    copied,
    skipped,
    externalImports: Array.from(externalImports),
    depsInstalled: depsResult.installed,
    depsError: depsResult.error,
  }));
}

function _resolveRelativeImport(fromDir, spec, dsPath) {
  const base = path.resolve(fromDir, spec);
  // Tenta extensions
  const exts = ["", ".tsx", ".ts", ".jsx", ".js", ".css", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
  for (const ext of exts) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      // Garante que o arquivo está dentro do DS
      if (p.startsWith(dsPath + path.sep)) return p;
    }
  }
  return null;
}

function _newestMtime(dir, relPaths) {
  let newest = 0;
  for (const rel of relPaths || []) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) continue;
    const walk = (f) => {
      let st; try { st = fs.statSync(f); } catch { return; }
      if (st.isDirectory()) { for (const c of fs.readdirSync(f)) { if (c === "node_modules" || c === ".git") continue; walk(path.join(f, c)); } }
      else if (st.mtimeMs > newest) newest = st.mtimeMs;
    };
    try { walk(p); } catch {}
  }
  return newest;
}

// (a) Auto-sync: detecta se o DS mudou desde a última sync (commit novo OU arquivos editados).
function dsCheckDrift(targetRaw, res) {
  const target = _safeProjectPath(targetRaw);
  if (!target) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ linked: false, drifted: false })); }
  const meta = readProjectMeta(target);
  if (!meta || !meta.designSystem || !meta.designSystem.projectPath) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ linked: false, drifted: false })); }
  const ds = meta.designSystem;
  const dsPath = ds.projectPath;
  const dsMeta = readProjectMeta(dsPath);
  const syncPaths = (dsMeta && Array.isArray(dsMeta.syncPaths) && dsMeta.syncPaths.length) ? dsMeta.syncPaths : (ds.syncPaths || []);
  const dsSha = _gitShaSync(dsPath);
  const lastSyncSha = ds.lastSyncSha || null;
  const lastSyncMs = ds.lastSyncAt ? Date.parse(ds.lastSyncAt) : 0;
  const newest = _newestMtime(dsPath, syncPaths);
  const shaDrift = !!(dsSha && lastSyncSha && dsSha !== lastSyncSha);
  const mtimeDrift = !!(newest > 0 && lastSyncMs > 0 && newest > lastSyncMs + 1500);
  const drifted = shaDrift || mtimeDrift;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ linked: true, drifted, dsName: ds.name || path.basename(dsPath), reason: shaDrift ? "commit novo no DS" : (mtimeDrift ? "arquivos do DS editados" : "") }));
}

// (b) Back-sync: promove um componente do projeto PRO design system (copia + registra no barrel).
async function promoteToDesignSystem(targetRaw, fileRaw, res) {
  const target = _safeProjectPath(targetRaw);
  if (!target) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Caminho fora de ~/dev/projetos" })); }
  const meta = readProjectMeta(target);
  if (!meta || !meta.designSystem || !meta.designSystem.projectPath) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Projeto sem DS vinculado — não dá pra promover" })); }
  const dsPath = meta.designSystem.projectPath;
  const file = String(fileRaw || "").split(":")[0].replace(/^\/+/, "");
  if (!/\.(tsx?|jsx?)$/i.test(file)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Só componentes .tsx/.ts/.jsx/.js podem ser promovidos" })); }
  const fromAbs = path.join(target, file);
  if (!fromAbs.startsWith(target + path.sep) || !fs.existsSync(fromAbs)) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Arquivo não encontrado: " + file })); }
  // Destino no DS: mantém o subpath se já é ui/composites; senão vai pra src/components/ui/
  let destRel;
  if (file.indexOf("src/components/ui/") === 0 || file.indexOf("src/composites/") === 0) destRel = file;
  else destRel = "src/components/ui/" + path.basename(file);
  const destAbs = path.join(dsPath, destRel);
  if (!destAbs.startsWith(dsPath + path.sep)) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "destino fora do DS" })); }
  const existed = fs.existsSync(destAbs);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.copyFileSync(fromAbs, destAbs);
  // Registra no barrel export do DS
  let exportAdded = false;
  try {
    const barrelRel = destRel.indexOf("src/composites/") === 0 ? "src/composites/index.ts" : "src/components/ui/index.ts";
    const barrel = path.join(dsPath, barrelRel);
    const base = "./" + path.basename(destRel).replace(/\.(tsx?|jsx?)$/, "");
    if (fs.existsSync(barrel)) {
      let bc = fs.readFileSync(barrel, "utf8");
      if (bc.indexOf("'" + base + "'") < 0 && bc.indexOf('"' + base + '"') < 0) {
        bc = bc.replace(/\s*$/, "") + "\nexport * from '" + base + "'\n";
        fs.writeFileSync(barrel, bc);
        exportAdded = true;
      }
    }
  } catch {}
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, dest: destRel, existed, exportAdded, dsName: meta.designSystem.name || path.basename(dsPath), dsPath }));
}

function unlinkDesignSystem(targetRaw, res) {
  const target = _safeProjectPath(targetRaw);
  if (!target) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Caminho fora de ~/dev/projetos" })); }
  const meta = readProjectMeta(target);
  if (!meta) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: ".nook-project.json nao encontrado" })); }
  delete meta.designSystem;
  writeProjectMeta(target, meta);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

// ── Canvas: discover screens to show (Index + pages + modals) ──
function _looksLikeModal(filename, content) {
  if (/(?:^|\/)(?:[A-Z]\w*)?(?:Modal|Dialog|Sheet|Drawer|Popover|Alert)\.tsx$/.test(filename)) return true;
  // Imports a shadcn dialog/sheet/drawer/alert-dialog primitive
  if (/from\s+["']@\/components\/ui\/(?:dialog|sheet|drawer|alert-dialog|popover)["']/i.test(content)) return true;
  return false;
}

function listCanvasFrames(projectPath, res) {
  const safe = _safeProjectPath(projectPath);
  if (!safe) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "caminho invalido" }));
  }
  const frames = [];
  const seen = new Set();
  // Always include App.tsx as the Index frame
  const appPath = path.join(safe, "src", "App.tsx");
  if (fs.existsSync(appPath)) {
    frames.push({ name: "Index", path: "/src/App.tsx", relPath: "src/App.tsx", kind: "index" });
    seen.add("/src/App.tsx");
  }
  // Pages — separate routes/screens
  const pagesRoot = path.join(safe, "src", "pages");
  if (fs.existsSync(pagesRoot)) {
    const walk = (dir, relSeg) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        const next = relSeg ? relSeg + "/" + e.name : e.name;
        if (e.isDirectory()) {
          if (e.name === "node_modules" || e.name.startsWith(".")) continue;
          walk(fp, next);
          continue;
        }
        if (!e.isFile() || !/\.tsx$/.test(e.name)) continue;
        let content;
        try { content = fs.readFileSync(fp, "utf8"); } catch { continue; }
        if (!/export\s+default\s+/m.test(content)) continue;
        const importPath = "/src/pages/" + next;
        if (seen.has(importPath)) continue;
        seen.add(importPath);
        const name = e.name.replace(/\.tsx$/, "");
        const kind = _looksLikeModal(e.name, content) ? "modal" : "page";
        frames.push({ name, path: importPath, relPath: "src/pages/" + next, kind });
      }
    };
    walk(pagesRoot, "");
  }
  // Components — only those that look like modals
  const compsRoot = path.join(safe, "src", "components");
  if (fs.existsSync(compsRoot)) {
    const walk = (dir, relSeg) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        const next = relSeg ? relSeg + "/" + e.name : e.name;
        if (e.isDirectory()) {
          if (e.name === "ui" || e.name === "node_modules" || e.name.startsWith(".")) continue;
          walk(fp, next);
          continue;
        }
        if (!e.isFile() || !/\.tsx$/.test(e.name)) continue;
        let content;
        try { content = fs.readFileSync(fp, "utf8"); } catch { continue; }
        if (!/export\s+default\s+/m.test(content)) continue;
        if (!_looksLikeModal(e.name, content)) continue;
        const importPath = "/src/components/" + next;
        if (seen.has(importPath)) continue;
        seen.add(importPath);
        const name = e.name.replace(/\.tsx$/, "");
        frames.push({ name, path: importPath, relPath: "src/components/" + next, kind: "modal" });
      }
    };
    walk(compsRoot, "");
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ frames }));
}

// ── Canvas: write per-project mount infrastructure if missing ──
function ensureCanvasMount(projectPath, res) {
  const safe = _safeProjectPath(projectPath);
  if (!safe) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "caminho invalido" }));
  }
  const created = [];
  try {
    const mountTsxPath = path.join(safe, "src", "__canvas_mount.tsx");
    const mountHtmlPath = path.join(safe, "__canvas.html");
    if (!fs.existsSync(mountTsxPath)) {
      fs.writeFileSync(mountTsxPath, CANVAS_MOUNT_TSX);
      created.push("src/__canvas_mount.tsx");
    }
    if (!fs.existsSync(mountHtmlPath)) {
      fs.writeFileSync(mountHtmlPath, CANVAS_MOUNT_HTML);
      created.push("__canvas.html");
    }
    // gitignore the canvas infra
    const giPath = path.join(safe, ".gitignore");
    let gi = "";
    try { gi = fs.readFileSync(giPath, "utf8"); } catch {}
    const lines = ["__canvas.html", "src/__canvas_mount.tsx"];
    let needWrite = false;
    for (const ln of lines) {
      if (!gi.split(/\r?\n/).includes(ln)) { gi += (gi.endsWith("\n") || gi === "" ? "" : "\n") + "\n# Nook Canvas (dev only)\n" + ln + "\n"; needWrite = true; break; }
    }
    if (needWrite) {
      // re-add any missing lines after the section header was created
      for (const ln of lines) {
        if (!gi.split(/\r?\n/).includes(ln)) gi += ln + "\n";
      }
      fs.writeFileSync(giPath, gi);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, created }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

const CANVAS_MOUNT_TSX = `// AUTO-GENERATED by Nook Studio Canvas. Loaded by __canvas.html in dev only.
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";

const params = new URLSearchParams(window.location.search);
const importPath = params.get("p") || "/src/App.tsx";
const exportName = params.get("e") || "default";
const dark = params.get("d") !== "0";
const kind = params.get("kind") || "page";

const root = document.getElementById("root")!;

(async () => {
  try {
    const mod = await import(/* @vite-ignore */ importPath);
    const Comp = exportName === "default" ? mod.default : (mod as any)[exportName];
    if (!Comp) {
      root.innerHTML = '<pre style="color:#ef4444;padding:14px;font:11px ui-monospace,monospace;white-space:pre-wrap">Sem export "' + exportName + '" em ' + importPath + '\\n\\nDisponivel: ' + Object.keys(mod).join(", ") + '</pre>';
      return;
    }
    const wrapperClass = (dark ? "dark " : "") + "min-h-screen bg-background text-foreground";
    // Modal kind: force open=true so the dialog is visible at mount time.
    const compProps: any = (kind === "modal") ? { open: true, onOpenChange: () => {} } : {};
    ReactDOM.createRoot(root).render(
      React.createElement("div", { className: wrapperClass },
        React.createElement(Comp as any, compProps))
    );
  } catch (e: any) {
    const msg = (e && e.message) ? e.message : String(e);
    root.innerHTML = '<pre style="color:#ef4444;padding:14px;font:11px ui-monospace,monospace;white-space:pre-wrap">Erro ao montar ' + importPath + ':\\n' + msg + '</pre>';
  }
})();
`;

const CANVAS_MOUNT_HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nook Canvas Mount</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/__canvas_mount.tsx"></script>
  </body>
</html>
`;

// Cleanup on shutdown — kill all dev servers
function killAllDevServers() {
  for (const [, s] of devServers) {
    try { if (s.proc) s.proc.kill("SIGTERM"); } catch {}
  }
}
process.on("exit", killAllDevServers);
process.on("SIGINT", () => { killAllDevServers(); process.exit(0); });
process.on("SIGTERM", () => { killAllDevServers(); process.exit(0); });

// ── Git Status ──
function gitStatus(res, cwd) {
  const root = cwd || __dirname;
  const proc = spawn("git", ["status", "--porcelain", "-b"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.on("close", () => {
    const lines = out.trim().split("\n");
    let branch = "";
    const files = [];
    for (const l of lines) {
      if (l.startsWith("##")) { branch = l.replace(/^## /, "").split("...")[0]; continue; }
      if (l.length < 3) continue;
      const status = l.slice(0, 2).trim() || "?";
      const name = l.slice(3);
      files.push({ status, name, path: path.join(root, name) });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ branch, files }));
  });
  proc.on("error", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ branch: "", files: [] })); });
}

// Run a git command in a project's cwd, return {ok, output, error}.
function gitRun(args, cwd, cb, opts) {
  const safe = path.resolve(cwd || "");
  if (!safe.startsWith("/home/diogo")) { cb({ ok: false, error: "Acesso negado" }); return; }
  if (!fs.existsSync(path.join(safe, ".git"))) { cb({ ok: false, error: "Nao eh um repo git" }); return; }
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const proc = spawn("git", args, { cwd: safe, stdio: ["ignore", "pipe", "pipe"], env, timeout: (opts && opts.timeoutMs) || 60000 });
  let out = "", err = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.stderr.on("data", c => (err += c.toString()));
  proc.on("close", code => {
    if (code === 0) cb({ ok: true, output: out + err });
    else cb({ ok: false, output: out, error: err || ("exit " + code) });
  });
  proc.on("error", e => cb({ ok: false, error: e.message }));
}

// One-shot do Claude via CLI (sem sidecar/key): só geração de TEXTO (resumos/descrições).
// SEM bypass de permissão — em modo -p headless as ferramentas ficam negadas, então isto
// não é um agente: só completa o prompt e sai. Não roda Bash/edita arquivos.
function claudeOneShot(prompt, cb) {
  const args = ["-p", String(prompt || ""), "--model", "haiku"];
  const proc = spawn("claude", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 });
  let out = "", err = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.stderr.on("data", c => (err += c.toString()));
  proc.on("close", code => cb(code === 0 ? { ok: true, text: out.trim() } : { ok: false, error: (err || out || ("exit " + code)).slice(-600) }));
  proc.on("error", e => cb({ ok: false, error: e.message }));
}

function readJsonBody(req, cb) {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    try { cb(null, body ? JSON.parse(body) : {}); }
    catch (e) { cb(e); }
  });
}

function gitJsonEndpoint(req, res, builder) {
  readJsonBody(req, (err, data) => {
    if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
    const args = builder(data);
    if (!args) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Parametros invalidos" })); }
    gitRun(args, data.cwd, (r) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    });
  });
}

// ── Search in Project ──
function searchInProject(query, searchPath, res) {
  const safePath = path.resolve(searchPath);
  if (!safePath.startsWith("/home/diogo")) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end("{}"); }
  const proc = spawn("grep", ["-rn", "--include=*.js", "--include=*.html", "--include=*.json", "--include=*.css", "--include=*.md", "--include=*.ts", "--include=*.py", "-l", "-m", "5", query, safePath], { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  let out = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.on("close", () => {
    const results = out.trim().split("\n").filter(Boolean).slice(0, 20).map(line => {
      const name = path.basename(line);
      return { path: line.trim(), name, lineNum: "" };
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results }));
  });
  proc.on("error", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ results: [] })); });
}

// ── FS Mutations (create/rename/delete files & dirs) ──
function fsAction(action, data, res) {
  const ok = (out) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(out || { ok: true })); };
  const fail = (msg, code) => { res.writeHead(code || 400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: msg })); };
  const safe = (p) => { if (!p) return null; const r = path.resolve(p); return r.startsWith("/home/diogo") ? r : null; };
  const validName = (n) => n && !n.includes("/") && !n.includes("\\") && n !== "." && n !== ".." && n.length < 255;
  try {
    if (action === "create") {
      const dir = safe(data.parent || "");
      if (!dir) return fail("Acesso negado", 403);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return fail("Pasta inválida");
      const name = (data.name || "").trim();
      if (!validName(name)) return fail("Nome inválido");
      const target = path.join(dir, name);
      if (!safe(target)) return fail("Acesso negado", 403);
      if (fs.existsSync(target)) return fail("Já existe");
      if (data.isDir) fs.mkdirSync(target);
      else fs.writeFileSync(target, "");
      return ok({ ok: true, path: target });
    }
    if (action === "rename") {
      const src = safe(data.path || "");
      if (!src) return fail("Acesso negado", 403);
      if (!fs.existsSync(src)) return fail("Não existe");
      const newName = (data.newName || "").trim();
      if (!validName(newName)) return fail("Nome inválido");
      const dst = path.join(path.dirname(src), newName);
      if (!safe(dst)) return fail("Acesso negado", 403);
      if (fs.existsSync(dst)) return fail("Já existe");
      fs.renameSync(src, dst);
      return ok({ ok: true, path: dst });
    }
    if (action === "delete") {
      const tgt = safe(data.path || "");
      if (!tgt) return fail("Acesso negado", 403);
      if (tgt === "/home/diogo" || tgt.length < 14) return fail("Caminho protegido");
      if (!fs.existsSync(tgt)) return fail("Não existe");
      const stat = fs.statSync(tgt);
      if (stat.isDirectory()) fs.rmSync(tgt, { recursive: true, force: false });
      else fs.unlinkSync(tgt);
      return ok({ ok: true });
    }
    if (action === "write") {
      const tgt = safe(data.path || "");
      if (!tgt) return fail("Acesso negado", 403);
      if (typeof data.content !== "string") return fail("content obrigatório");
      // Auto-create parent dir if missing (only one level)
      const parent = path.dirname(tgt);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(tgt, data.content);
      return ok({ ok: true, path: tgt, bytes: Buffer.byteLength(data.content, "utf8") });
    }
    return fail("Ação desconhecida");
  } catch (e) { return fail(e.message); }
}

// ── Terminal (safe, read-only-ish) ──
function runTerminal(cmd, cwd, res) {
  const safeCwd = path.resolve(cwd || __dirname);
  if (!safeCwd.startsWith("/home/diogo")) { res.writeHead(403, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ output: "Acesso negado" })); }
  const proc = spawn("bash", ["-c", cmd], { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
  let out = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.stderr.on("data", c => (out += c.toString()));
  proc.on("close", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ output: out.slice(0, 50000) })); });
  proc.on("error", (e) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ output: "Erro: " + e.message })); });
  setTimeout(() => { try { proc.kill(); } catch {} }, 10000);
}

// ── Test Runner (auto-detect project type and run tests) ──
function runTests(payload, res) {
  const safeCwd = path.resolve(payload.cwd || __dirname);
  if (!safeCwd.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Acesso negado" }));
  }
  // Auto-detect project type
  let cmd, kind;
  const has = (f) => fs.existsSync(path.join(safeCwd, f));
  if (payload.command) {
    cmd = payload.command; kind = "custom";
  } else if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(safeCwd, "package.json"), "utf8"));
      const t = pkg.scripts && pkg.scripts.test;
      // Skip the default placeholder npm injects ("Error: no test specified")
      const isPlaceholder = t && /no test specified/i.test(t);
      if (t && !isPlaceholder) { cmd = "npm test --silent 2>&1"; kind = "npm"; }
      else { cmd = null; }
    } catch { cmd = null; }
  }
  if (!cmd) {
    if (has("pyproject.toml") || has("pytest.ini") || has("conftest.py") || has("tests")) {
      // Prefer venv pytest if exists
      const venvPytest = path.join(safeCwd, ".venv/bin/pytest");
      cmd = (fs.existsSync(venvPytest) ? venvPytest : "pytest") + " -q --tb=short 2>&1";
      kind = "pytest";
    } else if (has("Cargo.toml")) {
      cmd = "cargo test 2>&1"; kind = "cargo";
    } else if (has("go.mod")) {
      cmd = "go test ./... 2>&1"; kind = "go";
    } else if (has("Makefile")) {
      cmd = "make test 2>&1"; kind = "make";
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, kind: "unknown", error: "Não detectei tipo de projeto (procurei package.json, pyproject.toml, Cargo.toml, go.mod, Makefile)" }));
    }
  }
  const proc = spawn("bash", ["-c", cmd], { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
  let out = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.stderr.on("data", c => (out += c.toString()));
  proc.on("close", code => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: code === 0, kind, command: cmd, output: out.slice(0, 200000), code }));
  });
  proc.on("error", e => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, kind, error: e.message }));
  });
  setTimeout(() => { try { proc.kill(); } catch {} }, 120000);
}

// ── Find & Replace across project ──
function findInProject(payload, res) {
  const safeRoot = path.resolve(payload.path || __dirname);
  if (!safeRoot.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ matches: [] }));
  }
  const query = payload.query || "";
  if (!query) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "query obrigatória" }));
  }
  // -E for regex, -F for fixed string (mutually exclusive). -n always (line numbers), -r recursive.
  const args = ["-rn", payload.regex ? "-E" : "-F"];
  if (!payload.caseSensitive) args.push("-i");
  const findIncludes = ["js","jsx","ts","tsx","mjs","cjs","py","go","rs","rb","java","kt","c","cpp","h","hpp","sh","bash","zsh","md","yml","yaml","toml","json","html","css","scss","sql","vue","svelte","txt"];
  for (const ext of findIncludes) args.push("--include=*." + ext);
  args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.venv", "--exclude-dir=venv");
  args.push("--exclude-dir=__pycache__", "--exclude-dir=dist", "--exclude-dir=build", "--exclude-dir=.next");
  args.push("--exclude-dir=target", "--exclude-dir=.cache");
  args.push(query, safeRoot);
  const proc = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  let out = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.on("close", () => {
    const byFile = {};
    let total = 0;
    for (const line of out.split("\n")) {
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineNum, txt] = m;
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push({ line: parseInt(lineNum, 10), text: txt.slice(0, 400) });
      total++;
      if (total >= 1000) break;
    }
    const files = Object.keys(byFile).sort().map(f => ({ path: f, matches: byFile[f] }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files, total, truncated: total >= 1000 }));
  });
  proc.on("error", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ files: [], total: 0 }));
  });
  setTimeout(() => { try { proc.kill(); } catch {} }, 20000);
}

function replaceInFiles(payload, res) {
  const safeRoot = path.resolve(payload.path || __dirname);
  if (!safeRoot.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false }));
  }
  const query = payload.query || "";
  const replacement = payload.replacement;
  const fileList = Array.isArray(payload.files) ? payload.files : [];
  if (!query || typeof replacement !== "string" || !fileList.length) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "query, replacement e files obrigatórios" }));
  }
  let pattern;
  try {
    if (payload.regex) pattern = new RegExp(query, payload.caseSensitive ? "g" : "gi");
    else pattern = new RegExp(query.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), payload.caseSensitive ? "g" : "gi");
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "regex inválido: " + e.message }));
  }
  const results = [];
  for (const f of fileList) {
    const safe = path.resolve(f);
    if (!safe.startsWith(safeRoot)) { results.push({ path: f, ok: false, error: "fora do projeto" }); continue; }
    if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) { results.push({ path: f, ok: false, error: "não existe" }); continue; }
    try {
      const orig = fs.readFileSync(safe, "utf8");
      const before = (orig.match(pattern) || []).length;
      if (before === 0) { results.push({ path: f, ok: true, replaced: 0 }); continue; }
      const updated = orig.replace(pattern, replacement);
      // Backup
      fs.writeFileSync(safe + ".bak", orig);
      fs.writeFileSync(safe, updated);
      results.push({ path: f, ok: true, replaced: before });
    } catch (e) {
      results.push({ path: f, ok: false, error: e.message });
    }
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, results, totalReplaced: results.reduce((s, r) => s + (r.replaced || 0), 0) }));
}

// ── TODOs scan (TODO/FIXME/HACK/XXX/NOTE) ──
function listTodos(rootPath, res) {
  const safeRoot = path.resolve(rootPath || __dirname);
  if (!safeRoot.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ items: [] }));
  }
  // grep -rnE pattern with sane include filters; exclude node_modules etc
  const includes = ["js","jsx","ts","tsx","mjs","cjs","py","go","rs","rb","java","kt","c","cpp","h","hpp","sh","bash","zsh","md","yml","yaml","toml","json","html","css","scss","sql","vue","svelte"];
  const args = ["-rnE"];
  for (const ext of includes) args.push("--include=*." + ext);
  args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.venv", "--exclude-dir=venv",
    "--exclude-dir=__pycache__", "--exclude-dir=dist", "--exclude-dir=build", "--exclude-dir=.next",
    "--exclude-dir=target", "--exclude-dir=.cache");
  args.push("(TODO|FIXME|HACK|XXX|NOTE)([: ])", safeRoot);
  const proc = spawn("grep", args, { stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  let out = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.on("close", () => {
    const items = [];
    for (const line of out.split("\n")) {
      // Format: /abs/path:NN:full line
      const m = line.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lineNum, txt] = m;
      // Categorize
      const tagMatch = txt.match(/(TODO|FIXME|HACK|XXX|NOTE)/);
      if (!tagMatch) continue;
      // Strip leading comment markers
      const clean = txt.replace(/^\s*(?:\/\/|#|<!--|--|\/\*)\s*/, "").trim();
      items.push({
        path: file,
        line: parseInt(lineNum, 10),
        tag: tagMatch[1],
        text: clean.slice(0, 240),
      });
      if (items.length >= 500) break;
    }
    // Group by tag count
    const counts = {};
    for (const it of items) counts[it.tag] = (counts[it.tag] || 0) + 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items, counts, total: items.length, root: safeRoot }));
  });
  proc.on("error", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ items: [], total: 0, error: "grep falhou" }));
  });
  setTimeout(() => { try { proc.kill(); } catch {} }, 20000);
}

// ── Files Flat: fuzzy search index for Cmd+K ──
function listFilesFlat(rootPath, res) {
  const safeRoot = path.resolve(rootPath || __dirname);
  if (!safeRoot.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ files: [] }));
  }
  const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".cache", ".pytest_cache", ".mypy_cache", "target"]);
  const out = [];
  const MAX = 5000;
  const walk = (dir, depth) => {
    if (out.length >= MAX || depth > 10) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX) return;
      if (e.name.startsWith(".") && !["..", "."].includes(e.name) && SKIP.has(e.name)) continue;
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        out.push({ path: full, name: e.name, rel: path.relative(safeRoot, full) });
      }
    }
  };
  walk(safeRoot, 0);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ files: out, truncated: out.length >= MAX }));
}

// ── Lint Runner (auto-detect linter and run) ──
function runLint(payload, res) {
  const safeCwd = path.resolve(payload.cwd || __dirname);
  if (!safeCwd.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Acesso negado" }));
  }
  const has = (f) => fs.existsSync(path.join(safeCwd, f));
  const venv = (bin) => fs.existsSync(path.join(safeCwd, ".venv/bin/" + bin));
  let cmd, kind;
  if (payload.command) {
    cmd = payload.command; kind = "custom";
  } else if (has("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(safeCwd, "package.json"), "utf8"));
      const lintScript = pkg.scripts && (pkg.scripts.lint || pkg.scripts["lint:check"]);
      if (lintScript) { cmd = "npm run lint --silent 2>&1"; kind = "npm-lint"; }
      else if (has("node_modules/.bin/eslint")) { cmd = "./node_modules/.bin/eslint . 2>&1"; kind = "eslint"; }
      else if (has("eslint.config.js") || has(".eslintrc.json") || has(".eslintrc.js")) { cmd = "npx --no-install eslint . 2>&1"; kind = "eslint"; }
    } catch {}
  }
  if (!cmd && (has("pyproject.toml") || has("ruff.toml") || venv("ruff"))) {
    const ruff = venv("ruff") ? path.join(safeCwd, ".venv/bin/ruff") : "ruff";
    cmd = ruff + " check . 2>&1"; kind = "ruff";
  }
  if (!cmd && (has("mypy.ini") || has("pyproject.toml") || venv("mypy"))) {
    const mypy = venv("mypy") ? path.join(safeCwd, ".venv/bin/mypy") : "mypy";
    cmd = mypy + " . 2>&1"; kind = "mypy";
  }
  if (!cmd && has("Cargo.toml")) {
    cmd = "cargo clippy -- -D warnings 2>&1"; kind = "clippy";
  }
  if (!cmd && has("go.mod")) {
    cmd = "(command -v golangci-lint && golangci-lint run) || go vet ./... 2>&1"; kind = "go";
  }
  if (!cmd) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, kind: "unknown", error: "Não detectei linter (procurei eslint/ruff/mypy/clippy/golangci-lint)" }));
  }
  const proc = spawn("bash", ["-c", cmd], { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 90000 });
  let out = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.stderr.on("data", c => (out += c.toString()));
  proc.on("close", code => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: code === 0, kind, command: cmd, output: out.slice(0, 200000), code }));
  });
  proc.on("error", e => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, kind, error: e.message }));
  });
  setTimeout(() => { try { proc.kill(); } catch {} }, 90000);
}

// ── Git Branches (list/checkout/create/delete) ──
function gitBranchAction(action, payload, res) {
  const safeCwd = path.resolve(payload.cwd || __dirname);
  if (!safeCwd.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Acesso negado" }));
  }
  const validBranchName = (n) => n && /^[\w][\w./\-]{0,99}$/.test(n) && !n.includes("..");

  if (action === "list") {
    const proc = spawn("git", ["for-each-ref", "--format=%(refname:short)|%(committerdate:relative)|%(objectname:short)", "refs/heads", "refs/remotes"], { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let out = "", err = "";
    proc.stdout.on("data", c => (out += c.toString()));
    proc.stderr.on("data", c => (err += c.toString()));
    proc.on("close", code => {
      if (code !== 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: err.trim() || "git falhou" }));
      }
      // Get current branch
      const cur = spawn("git", ["branch", "--show-current"], { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"] });
      let curOut = "";
      cur.stdout.on("data", c => (curOut += c.toString()));
      cur.on("close", () => {
        const current = curOut.trim();
        const branches = out.trim().split("\n").filter(Boolean).map(line => {
          const [name, when, sha] = line.split("|");
          const isRemote = name.startsWith("origin/") || /^[^/]+\//.test(name);
          return { name, isRemote, isCurrent: name === current, when: when || "", sha: sha || "" };
        });
        // Dedup: prefer local over origin/<same>
        const localNames = new Set(branches.filter(b => !b.isRemote).map(b => b.name));
        const filtered = branches.filter(b => !(b.isRemote && localNames.has(b.name.replace(/^[^/]+\//, ""))));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, branches: filtered, current }));
      });
    });
    return;
  }
  if (action === "checkout") {
    const branch = (payload.branch || "").trim();
    if (!validBranchName(branch)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "nome de branch inválido" }));
    }
    // For remote refs (origin/foo), checkout creates a local tracking branch
    let args;
    if (branch.includes("/") && !payload.fromRemote) args = ["checkout", branch];
    else if (payload.fromRemote) {
      const localName = branch.replace(/^[^/]+\//, "");
      args = ["checkout", "-b", localName, branch];
    } else args = ["checkout", branch];
    const proc = spawn("git", args, { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
    let out = "", err = "";
    proc.stdout.on("data", c => (out += c.toString()));
    proc.stderr.on("data", c => (err += c.toString()));
    proc.on("close", code => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: code === 0, output: out, error: err, code }));
    });
    return;
  }
  if (action === "create") {
    const branch = (payload.branch || "").trim();
    if (!validBranchName(branch)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "nome de branch inválido" }));
    }
    const args = ["checkout", "-b", branch];
    if (payload.from) args.push(payload.from);
    const proc = spawn("git", args, { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let out = "", err = "";
    proc.stdout.on("data", c => (out += c.toString()));
    proc.stderr.on("data", c => (err += c.toString()));
    proc.on("close", code => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: code === 0, output: out, error: err, code }));
    });
    return;
  }
  if (action === "delete") {
    const branch = (payload.branch || "").trim();
    if (!validBranchName(branch)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "nome de branch inválido" }));
    }
    const args = ["branch", payload.force ? "-D" : "-d", branch];
    const proc = spawn("git", args, { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
    let out = "", err = "";
    proc.stdout.on("data", c => (out += c.toString()));
    proc.stderr.on("data", c => (err += c.toString()));
    proc.on("close", code => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: code === 0, output: out, error: err, code }));
    });
    return;
  }
  res.writeHead(400, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "ação inválida" }));
}

// ── Git Actions (commit/push/pull/diff/stash) ──
function gitAction(action, payload, res) {
  const safeCwd = path.resolve(payload.cwd || __dirname);
  if (!safeCwd.startsWith("/home/diogo")) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "Acesso negado" }));
  }
  let args;
  switch (action) {
    case "commit": {
      const msg = (payload.message || "").trim();
      if (!msg) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "mensagem obrigatória" }));
      }
      const stageAll = payload.stageAll !== false; // default true
      // Use array form to avoid shell injection. For -m we still pass as single arg.
      // Compose as a small bash so we can chain stage + commit; sanitize msg by passing via env.
      const env = { ...process.env, NOOK_COMMIT_MSG: msg };
      const cmd = (stageAll ? "git add -A && " : "") + 'git commit -m "$NOOK_COMMIT_MSG"';
      const proc = spawn("bash", ["-c", cmd], { cwd: safeCwd, env, stdio: ["ignore", "pipe", "pipe"], timeout: 15000 });
      let out = "", err = "";
      proc.stdout.on("data", c => (out += c.toString()));
      proc.stderr.on("data", c => (err += c.toString()));
      proc.on("close", code => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: code === 0, output: out, error: err, code }));
      });
      return;
    }
    case "push": args = ["push"]; break;
    case "pull": args = ["pull", "--ff-only"]; break;
    case "stash": args = payload.pop ? ["stash", "pop"] : ["stash"]; break;
    case "diff": {
      const file = payload.file ? path.resolve(safeCwd, payload.file) : null;
      args = ["diff"];
      if (payload.staged) args.push("--cached");
      if (file && file.startsWith(safeCwd)) args.push("--", path.relative(safeCwd, file));
      break;
    }
    case "log": args = ["log", "--oneline", "--decorate", "-n", "20"]; break;
    default:
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "ação inválida" }));
  }
  const proc = spawn("git", args, { cwd: safeCwd, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
  let out = "", err = "";
  proc.stdout.on("data", c => (out += c.toString()));
  proc.stderr.on("data", c => (err += c.toString()));
  proc.on("close", code => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: code === 0, output: out.slice(0, 60000), error: err.slice(0, 4000), code }));
  });
  proc.on("error", e => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  });
}

// ── Server ──
const server = http.createServer({ requestTimeout: 0, headersTimeout: 0 }, (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Sidecar proxy: /api/core/* → http://127.0.0.1:3001/*
  if (req.url.startsWith("/api/core/")) return proxyToCore(req, res);

  if (req.url === "/api/status/claude" && req.method === "GET") return checkClaudeStatus(res);

  // Browser: launch Chrome with CDP so Cowork workers can attach to user's logged-in browser
  if (req.url.startsWith("/api/browser/launch-chrome") && req.method === "POST") {
    const u = new URL(req.url, "http://localhost");
    const force = u.searchParams.get("force") === "1";
    const { spawn } = require("child_process");
    const args = force ? ["--force"] : [];
    const proc = spawn("/home/diogo/dev/bin/nook-chrome", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (c) => out += c.toString());
    proc.stderr.on("data", (c) => err += c.toString());
    proc.on("close", (code) => {
      // Wait longer if force (Chrome restore takes time), then probe CDP
      const waitMs = force ? 4000 : 1500;
      setTimeout(async () => {
        let cdpUp = false;
        for (let i = 0; i < 5; i++) {
          try {
            const r = await fetch("http://localhost:9222/json/version", { signal: AbortSignal.timeout(2000) });
            if (r.ok) { cdpUp = true; break; }
          } catch {}
          await new Promise(r => setTimeout(r, 800));
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: code === 0 && cdpUp, exitCode: code, stdout: out.trim(), stderr: err.trim(), cdpUp }));
      }, waitMs);
    });
    proc.on("error", (e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Hub: busca por tag cross-folder
  if (req.url.startsWith("/api/hub/by-tag") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    const tag = (u.searchParams.get("tag") || "").trim().toLowerCase();
    if (!tag) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "tag obrigatória" })); }
    const out = [];
    const FOLDERS = ["snippets", "padroes", "decisoes", "memorias", "planos", "conversas", "usuario", "inbox", "arquivo", "projetos"];
    for (const folder of FOLDERS) {
      const dir = path.join(HUB_ROOT, folder);
      if (!fs.existsSync(dir)) continue;
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith(".md")); } catch { continue; }
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(dir, f), "utf8");
          let inFm = false;
          const fmBlock = content.match(/^---\n([\s\S]*?)\n---\n/);
          if (fmBlock) {
            const tagsLine = fmBlock[1].match(/tags:\s*\[([^\]]*)\]/);
            if (tagsLine) {
              const tags = tagsLine[1].split(",").map(t => t.trim().toLowerCase());
              if (tags.includes(tag)) inFm = true;
            }
          }
          const inBody = new RegExp("\\B#" + tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(content);
          if (inFm || inBody) {
            const titleMatch = content.match(/^titulo:\s*"?([^"\n]+?)"?$/m);
            out.push({
              path: folder + "/" + f,
              folder,
              title: titleMatch ? titleMatch[1].trim() : f.replace(/\.md$/, ""),
              source: inFm ? "frontmatter" : "body",
            });
          }
        } catch {}
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ tag, count: out.length, results: out }));
  }

  // Distill backfill — run distill on convs with >= N messages that haven't been distilled
  if (req.url.startsWith("/api/distill/backfill") && req.method === "POST") {
    const u = new URL(req.url, "http://localhost");
    const minMsgs = parseInt(u.searchParams.get("min") || "20", 10);
    const limit = parseInt(u.searchParams.get("limit") || "5", 10);
    (async () => {
      try {
        const allChats = chatStore.listChats({});
        const candidates = [];
        for (const c of allChats) {
          const msgs = chatStore.getMessages(c.id) || [];
          if (msgs.length >= minMsgs) candidates.push({ id: c.id, msgCount: msgs.length, title: c.title });
        }
        candidates.sort((a, b) => b.msgCount - a.msgCount);
        const toRun = candidates.slice(0, limit);
        const results = [];
        for (const c of toRun) {
          try {
            const r = await chatDistill.distillConversation(c.id);
            results.push({ id: c.id, title: c.title, msgCount: c.msgCount, ...r });
          } catch (e) {
            results.push({ id: c.id, title: c.title, msgCount: c.msgCount, error: e.message });
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, processed: results }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  // Profile (Kairos) endpoints
  if (req.url === "/api/profile" && req.method === "GET") {
    const p = profileLib.getProfile();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(p ? { ok: true, content: p.content, path: p.path } : { ok: false, content: "" }));
  }
  if (req.url === "/api/profile/regenerate" && req.method === "POST") {
    profileLib.generateProfile({}).then((r) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    }).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // Desktop shortcut
  if (req.url === "/api/desktop/install" && req.method === "POST") {
    try {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(installDesktopShortcut()));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  // Ultra Plan endpoints
  if (req.url === "/api/plan" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ plans: planLib.listPlans() }));
  }
  if (req.url === "/api/plan" && req.method === "POST") {
    let body = ""; req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const data = JSON.parse(body || "{}");
        const plan = await planLib.generatePlan({ goal: data.goal, projectPath: data.projectPath, model: data.model });
        const slug = planLib.savePlan(plan);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ slug, plan }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const planSlugMatch = req.url.match(/^\/api\/plan\/([^\/]+)$/);
  if (planSlugMatch && req.method === "GET") {
    const plan = planLib.readPlan(decodeURIComponent(planSlugMatch[1]));
    if (!plan) { res.writeHead(404); return res.end(JSON.stringify({ error: "plano não encontrado" })); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ plan }));
  }
  if (planSlugMatch && req.method === "DELETE") {
    const ok = planLib.deletePlan(decodeURIComponent(planSlugMatch[1]));
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok }));
  }
  const planNextMatch = req.url.match(/^\/api\/plan\/([^\/]+)\/run-next$/);
  if (planNextMatch && req.method === "POST") {
    try {
      const slug = decodeURIComponent(planNextMatch[1]);
      const plan = planLib.readPlan(slug);
      if (!plan) { res.writeHead(404); return res.end(JSON.stringify({ error: "plano não encontrado" })); }
      const next = planLib.nextRunnableStep(plan);
      if (!next) {
        const allDone = plan.etapas.every(e => e.status === "done" || e.status === "skipped");
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: true, runnable: false, reason: allDone ? "plano completo" : "sem etapa pronta (deps pendentes ou blocked)", plan }));
      }
      // Reuse execute logic by simulating a request
      req.url = "/api/plan/" + encodeURIComponent(slug) + "/step/" + next.id + "/execute";
      // fall through? — easier: replicate the spawn here
      const projectPath = plan.projeto ? path.join(PROJETOS_ROOT, plan.projeto) : null;
      const planContext = "PLANO: " + (plan.titulo || "") + "\nGOAL: " + (plan.goal || "") + "\nETAPAS GERAIS: " +
        plan.etapas.map(e => `${e.id}. ${e.titulo} [${e.status || "pending"}]`).join("; ") +
        "\n\nETAPA ATUAL (#" + next.id + "): " + (next.titulo || "") +
        "\nCRITÉRIO: " + (next.criterio || "execute o passo") +
        "\n\nQUANDO TERMINAR: faça `curl -s -X PATCH http://localhost:3000/api/plan/" + slug + "/step/" + next.id + " -H 'Content-Type: application/json' -d '{\"status\":\"done\",\"notas\":\"<o que foi feito>\"}'`. Pra avançar plano automático: `curl -s -X POST http://localhost:3000/api/plan/" + slug + "/run-next`. Se bloqueado, status \"blocked\" com motivo nas notas.";
      const w = workerRegistry.create({
        title: "Plan auto: " + (plan.titulo || "").slice(0, 30) + " · etapa " + next.id,
        provider: "claude",
        model: "claude-sonnet-4-6",
        systemPrompt: planContext,
        cwd: projectPath && fs.existsSync(projectPath) ? projectPath : null,
      });
      setImmediate(() => {
        w.sendMessage("Execute a etapa " + next.id + ": " + (next.titulo || "") + ". " + (next.criterio ? "Critério: " + next.criterio : "")).catch(() => {});
      });
      try { planLib.updateStep(slug, next.id, { status: "in-progress" }); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, runnable: true, workerId: w.id, stepId: next.id, plan: planLib.readPlan(slug) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  const planExecMatch = req.url.match(/^\/api\/plan\/([^\/]+)\/step\/(\d+)\/execute$/);
  if (planExecMatch && req.method === "POST") {
    try {
      const slug = decodeURIComponent(planExecMatch[1]);
      const stepId = parseInt(planExecMatch[2], 10);
      const plan = planLib.readPlan(slug);
      if (!plan) { res.writeHead(404); return res.end(JSON.stringify({ error: "plano não encontrado" })); }
      const step = plan.etapas.find(e => e.id === stepId);
      if (!step) { res.writeHead(404); return res.end(JSON.stringify({ error: "etapa não encontrada" })); }
      const projectPath = plan.projeto ? path.join(PROJETOS_ROOT, plan.projeto) : null;
      const planContext = "PLANO: " + (plan.titulo || "") + "\nGOAL: " + (plan.goal || "") + "\nETAPAS GERAIS: " +
        plan.etapas.map(e => `${e.id}. ${e.titulo} [${e.status || "pending"}]`).join("; ") +
        "\n\nETAPA ATUAL (#" + stepId + "): " + (step.titulo || "") +
        "\nCRITÉRIO: " + (step.criterio || "execute o passo") +
        "\n\nQUANDO TERMINAR: " +
        "`curl -s -X PATCH http://localhost:3000/api/plan/" + slug + "/step/" + stepId + " -H 'Content-Type: application/json' -d '{\"status\":\"done\",\"notas\":\"<o que foi feito>\"}'`. " +
        "Pra avançar pra próxima etapa automaticamente: " +
        "`curl -s -X POST http://localhost:3000/api/plan/" + slug + "/run-next`. " +
        "Se bloqueado, status \"blocked\" com motivo nas notas.";
      const w = workerRegistry.create({
        title: "Plan: " + (plan.titulo || "").slice(0, 30) + " · etapa " + stepId,
        provider: "claude",
        model: "claude-sonnet-4-6",
        systemPrompt: planContext,
        cwd: projectPath && fs.existsSync(projectPath) ? projectPath : null,
      });
      // Fire-and-forget initial message
      setImmediate(() => {
        w.sendMessage("Execute a etapa " + stepId + " do plano: " + (step.titulo || "") + ". " + (step.criterio ? "Critério de conclusão: " + step.criterio : "")).catch(() => {});
      });
      try { planLib.updateStep(slug, stepId, { status: "in-progress" }); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, workerId: w.id, plan: planLib.readPlan(slug) }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  const planStepMatch = req.url.match(/^\/api\/plan\/([^\/]+)\/step\/(\d+)$/);
  if (planStepMatch && req.method === "PATCH") {
    let body = ""; req.on("data", (c) => body += c);
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const slug = decodeURIComponent(planStepMatch[1]);
        const plan = planLib.updateStep(slug, planStepMatch[2], data);
        // Auto-chain: if step finished done AND chain is enabled, fire run-next in background
        const autoChain = data.chain === true || process.env.NOOK_PLAN_AUTO_CHAIN === "1";
        if (autoChain && data.status === "done") {
          const next = planLib.nextRunnableStep(plan);
          if (next) {
            setImmediate(() => {
              try {
                const projectPath = plan.projeto ? path.join(PROJETOS_ROOT, plan.projeto) : null;
                const planContext = "PLANO: " + (plan.titulo || "") + "\nGOAL: " + (plan.goal || "") + "\nETAPA #" + next.id + ": " + (next.titulo || "") + "\nCRITÉRIO: " + (next.criterio || "");
                const w2 = workerRegistry.create({
                  title: "Plan auto: " + (plan.titulo || "").slice(0, 30) + " · etapa " + next.id,
                  provider: "claude",
                  model: "claude-sonnet-4-6",
                  systemPrompt: planContext + "\n\nQUANDO TERMINAR: PATCH /api/plan/" + slug + "/step/" + next.id + " com {\"status\":\"done\",\"chain\":true} pra continuar a cadeia.",
                  cwd: projectPath && fs.existsSync(projectPath) ? projectPath : null,
                });
                w2.sendMessage("Execute etapa " + next.id + ": " + (next.titulo || "") + ". " + (next.criterio || "")).catch(() => {});
                planLib.updateStep(slug, next.id, { status: "in-progress" });
              } catch (e) { console.error("[plan auto-chain]", e.message); }
            });
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ plan }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === "/api/diagnostics" && req.method === "GET") {
    collectDiagnostics().then((checks) => {
      const worst = checks.some(c => c.status === "fail") ? "fail" : checks.some(c => c.status === "warn") ? "warn" : "ok";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ overall: worst, checks }));
    }).catch((e) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }
  if (req.url === "/api/ollama/models" && req.method === "GET") return fetchOllamaModels(res);
  if (req.url === "/api/upload" && req.method === "POST") return handleUpload(req, res);
  if (req.url === "/api/upload-from-path" && req.method === "POST") return handleUploadFromPath(req, res);

  // File browser (Code Mode)
  if (req.url.startsWith("/api/files-flat") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return listFilesFlat(u.searchParams.get("path") || __dirname, res);
  }
  if (req.url.startsWith("/api/todos") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return listTodos(u.searchParams.get("path") || __dirname, res);
  }
  if (req.url === "/api/find" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      try { findInProject(body ? JSON.parse(body) : {}, res); }
      catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (req.url === "/api/replace" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      try { replaceInFiles(body ? JSON.parse(body) : {}, res); }
      catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (req.url.startsWith("/api/files") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return listFiles(u.searchParams.get("path") || __dirname, res);
  }
  if (req.url.startsWith("/api/file-content") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return readFileContent(u.searchParams.get("path") || "", res);
  }
  if (req.url.startsWith("/api/git-status") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return gitStatus(res, u.searchParams.get("path") || __dirname);
  }
  if (req.url === "/api/git/pull" && req.method === "POST") {
    return gitJsonEndpoint(req, res, () => ["pull", "--ff-only"]);
  }
  if (req.url === "/api/git/push" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      // Auto set upstream on first push
      gitRun(["push"], data.cwd, (r) => {
        if (!r.ok && /no upstream branch|set-upstream/i.test(r.error || "")) {
          gitRun(["rev-parse", "--abbrev-ref", "HEAD"], data.cwd, (b) => {
            const branch = (b.output || "").trim();
            if (b.ok && branch) {
              gitRun(["push", "-u", "origin", branch], data.cwd, (r2) => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(r2));
              });
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(r));
            }
          });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      });
    });
  }
  if (req.url === "/api/git/stash" && req.method === "POST") {
    return gitJsonEndpoint(req, res, () => ["stash"]);
  }
  if (req.url === "/api/git/diff" && req.method === "POST") {
    return gitJsonEndpoint(req, res, (d) => d.staged ? ["diff", "--staged"] : ["diff"]);
  }
  if (req.url === "/api/git/commit" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err || !data.message) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Mensagem obrigatoria" })); }
      const finish = () => gitRun(["commit", "-m", data.message], data.cwd, (r) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      });
      if (data.stageAll) gitRun(["add", "-A"], data.cwd, (r) => { if (!r.ok) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(r)); } finish(); });
      else finish();
    });
  }
  if (req.url === "/api/git/branches/list" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      gitRun(["branch", "--list"], data.cwd, (r) => {
        if (!r.ok) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(r)); }
        const branches = [], lines = (r.output || "").split("\n");
        let current = "";
        for (const ln of lines) {
          const t = ln.trim(); if (!t) continue;
          const isCurrent = t.startsWith("*");
          const name = t.replace(/^\*\s*/, "").trim();
          if (!name) continue;
          if (isCurrent) current = name;
          branches.push({ name, current: isCurrent });
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, branches, current }));
      });
    });
  }
  if (req.url === "/api/git/branches/create" && req.method === "POST") {
    return gitJsonEndpoint(req, res, (d) => d.name && /^[A-Za-z0-9._\/-]+$/.test(d.name) ? ["checkout", "-b", d.name] : null);
  }
  if (req.url === "/api/git/branches/checkout" && req.method === "POST") {
    return gitJsonEndpoint(req, res, (d) => d.name && /^[A-Za-z0-9._\/-]+$/.test(d.name) ? ["checkout", d.name] : null);
  }
  if (req.url === "/api/git/branches/delete" && req.method === "POST") {
    return gitJsonEndpoint(req, res, (d) => d.name && /^[A-Za-z0-9._\/-]+$/.test(d.name) ? ["branch", d.force ? "-D" : "-d", d.name] : null);
  }
  if (req.url === "/api/git/remote/get" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      gitRun(["remote", "get-url", "origin"], data.cwd, (r) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: r.ok, url: (r.output || "").trim(), error: r.error }));
      });
    });
  }
  if (req.url === "/api/git/log" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      const limit = Math.max(1, Math.min(parseInt(data.limit, 10) || 30, 200));
      const FS = "~JX~", RS = "~JC~";
      const fmt = ["%H", "%h", "%an", "%ae", "%aI", "%s", "%D"].join(FS) + RS;
      gitRun(["log", "-n", String(limit), "--pretty=format:" + fmt], data.cwd, (r) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (!r.ok) return res.end(JSON.stringify(r));
        const commits = (r.output || "").split(RS).map(s => s.replace(/^\s+/, "")).filter(s => s.includes(FS)).map(s => {
          const p = s.split(FS);
          return { hash: p[0], shortHash: p[1], author: p[2], email: p[3], date: p[4], subject: p[5], refs: p[6] || "" };
        });
        res.end(JSON.stringify({ ok: true, commits }));
      });
    });
  }
  if (req.url === "/api/git/fetch" && req.method === "POST") {
    return gitJsonEndpoint(req, res, () => ["fetch", "--all", "--prune"]);
  }
  if (req.url === "/api/git/ahead-behind" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      gitRun(["rev-list", "--left-right", "--count", "HEAD...@{u}"], data.cwd, (r) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (!r.ok) return res.end(JSON.stringify({ ok: false, error: r.error, output: r.output }));
        const m = (r.output || "").trim().split(/\s+/);
        res.end(JSON.stringify({ ok: true, ahead: parseInt(m[0], 10) || 0, behind: parseInt(m[1], 10) || 0 }));
      });
    });
  }
  if (req.url === "/api/git/show" && req.method === "POST") {
    return gitJsonEndpoint(req, res, (d) => d.hash && /^[0-9a-fA-F]{4,64}$/.test(d.hash) ? ["show", "--stat", "--patch", "-m", "--first-parent", d.hash] : null);
  }
  // Resumo legível de um commit: mensagem + lista de arquivos (status) + totais +/-,
  // pra mostrar "o que mudou" em vez do diff cru.
  if (req.url === "/api/git/commit-summary" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      const J = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      const hash = String(data.hash || "");
      if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return J({ ok: false, error: "hash invalido" });
      gitRun(["show", "--no-patch", "--format=%an%x1f%aI%x1f%B", hash], data.cwd, (m) => {
        if (!m.ok) return J({ ok: false, error: m.error || m.output || "falhou" });
        const parts = (m.output || "").split("\x1f");
        const author = parts[0] || "", date = parts[1] || "", message = (parts.slice(2).join("\x1f") || "").trim();
        gitRun(["show", "--name-status", "--format=", "-m", "--first-parent", hash], data.cwd, (ns) => {
          const files = [];
          (ns.output || "").split("\n").forEach((line) => {
            const mt = line.match(/^([A-Z])\d*\t(.+)$/);
            if (mt) { let p = mt[2]; if (p.indexOf("\t") >= 0) p = p.split("\t").pop(); files.push({ status: mt[1], path: p }); }
          });
          gitRun(["show", "--shortstat", "--format=", "-m", "--first-parent", hash], data.cwd, (ss) => {
            const sline = (ss.output || "").split("\n").map((s) => s.trim()).filter(Boolean).pop() || "";
            const ins = (sline.match(/(\d+) insertion/) || [])[1] || "0";
            const del = (sline.match(/(\d+) deletion/) || [])[1] || "0";
            J({ ok: true, author, date, message, files, insertions: +ins, deletions: +del });
          });
        });
      });
    });
  }
  // IA: explica um commit em português simples (sem código).
  if (req.url === "/api/git/ai-explain" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      const J = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      const hash = String(data.hash || "");
      if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return J({ ok: false, error: "hash invalido" });
      gitRun(["show", "--stat", "--patch", "-m", "--first-parent", hash], data.cwd, (r) => {
        if (!r.ok) return J({ ok: false, error: r.error || "falhou" });
        const diff = (r.output || "").slice(0, 14000);
        const prompt = "Explique em português brasileiro, de forma simples e curta (3 a 6 frases, SEM jargão técnico e SEM mostrar código), o que este commit fez na prática. Responda só com a explicação.\n\n" + diff;
        claudeOneShot(prompt, (a) => J(a.ok ? { ok: true, text: a.text } : { ok: false, error: a.error }));
      });
    });
  }
  // IA: gera mensagem de commit (título + descrição em bullets) a partir do diff.
  if (req.url === "/api/git/ai-commit-msg" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      const J = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      const args = data.staged ? ["diff", "--cached"] : ["diff", "HEAD"];
      gitRun(args, data.cwd, (r) => {
        if (!r.ok) return J({ ok: false, error: r.error || "git diff falhou" });
        const diff = (r.output || "").slice(0, 16000);
        if (!diff.trim()) return J({ ok: false, error: "Sem mudanças pra resumir" });
        const prompt = "Gere uma mensagem de commit em português brasileiro a partir do diff abaixo. Formato EXATO: primeira linha = título curto (até 60 caracteres) resumindo a mudança; depois uma linha em branco; depois de 2 a 5 marcadores começando com '- ' descrevendo o que mudou, em linguagem simples. Responda SÓ com a mensagem (sem aspas, sem crases, sem explicações).\n\n" + diff;
        claudeOneShot(prompt, (a) => J(a.ok ? { ok: true, message: a.text } : { ok: false, error: a.error }));
      });
    });
  }
  // Restaura o projeto pra um commit (NÃO-destrutivo): faz a árvore bater com o commit e
  // commita por cima — os commits posteriores continuam no histórico (parent do novo commit).
  if (req.url === "/api/git/restore-version" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      const J = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      const hash = String(data.hash || "");
      if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) return J({ ok: false, error: "hash invalido" });
      const short = hash.slice(0, 7);
      gitRun(["status", "--porcelain"], data.cwd, (st) => {
        if (!st.ok) return J({ ok: false, error: st.error || "git status falhou" });
        if ((st.output || "").trim()) return J({ ok: false, error: "Há mudanças não commitadas. Faça commit ou descarte antes de restaurar." });
        gitRun(["read-tree", "-u", "--reset", hash], data.cwd, (r1) => {
          if (!r1.ok) return J({ ok: false, error: r1.error || r1.output || "read-tree falhou" });
          gitRun(["commit", "-m", "Restaurar versão " + short], data.cwd, (r2) => {
            if (r2.ok) return J({ ok: true, short });
            const out = (r2.output || "") + (r2.error || "");
            if (/nothing to commit|working tree clean/i.test(out)) return J({ ok: true, short, message: "O projeto já estava nessa versão." });
            return J({ ok: false, error: r2.error || out || "commit falhou" });
          });
        });
      });
    });
  }
  // Desfaz o último commit MANTENDO as mudanças (reset --soft) — pra corrigir e commitar de novo.
  if (req.url === "/api/git/undo-last-commit" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      const J = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      gitRun(["reset", "--soft", "HEAD~1"], data.cwd, (r) => {
        if (r.ok) return J({ ok: true });
        return J({ ok: false, error: r.error || r.output || "Falhou (talvez só exista 1 commit)" });
      });
    });
  }
  if (req.url === "/api/git/last-push" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      gitRun(["remote", "get-url", "origin"], data.cwd, (g) => {
        if (!g.ok) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Sem remote origin" })); }
        const url = (g.output || "").trim();
        const m = url.match(/github\.com[:\/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
        if (!m) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Origin nao eh GitHub" })); }
        const repo = m[1];
        const proc = spawn("gh", ["repo", "view", repo, "--json", "pushedAt,url"], { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 });
        let out = "", errBuf = "";
        proc.stdout.on("data", c => (out += c.toString()));
        proc.stderr.on("data", c => (errBuf += c.toString()));
        proc.on("close", code => {
          res.writeHead(200, { "Content-Type": "application/json" });
          if (code !== 0) return res.end(JSON.stringify({ ok: false, error: errBuf || "gh falhou", repo }));
          try { const j = JSON.parse(out); res.end(JSON.stringify({ ok: true, repo, pushedAt: j.pushedAt, url: j.url })); }
          catch { res.end(JSON.stringify({ ok: false, error: "JSON invalido do gh", repo })); }
        });
        proc.on("error", e => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message, repo })); });
      });
    });
  }
  if (req.url === "/api/git/github/create-repo" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "JSON invalido" })); }
      const repo = data.repo || "";
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "Use 'owner/repo'" })); }
      const visibility = data.private === false ? "--public" : "--private";
      const proc = spawn("gh", ["repo", "create", repo, visibility], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
      let out = "", errBuf = "";
      proc.stdout.on("data", c => (out += c.toString()));
      proc.stderr.on("data", c => (errBuf += c.toString()));
      proc.on("close", code => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (code === 0) res.end(JSON.stringify({ ok: true, output: out + errBuf }));
        else res.end(JSON.stringify({ ok: false, output: out, error: errBuf || ("exit " + code) }));
      });
      proc.on("error", e => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: e.message })); });
    });
  }
  if (req.url === "/api/git/remote/set" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err || !data.url) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "URL obrigatoria" })); }
      if (!/^(https:\/\/|git@|ssh:\/\/)/.test(data.url)) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "URL invalida" })); }
      // Check if origin exists; if yes set-url, else add
      gitRun(["remote", "get-url", "origin"], data.cwd, (g) => {
        const args = g.ok ? ["remote", "set-url", "origin", data.url] : ["remote", "add", "origin", data.url];
        gitRun(args, data.cwd, (r) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(r));
        });
      });
    });
  }
  if (req.url === "/api/run-tests" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      try { runTests(body ? JSON.parse(body) : {}, res); }
      catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.url === "/api/qa-log" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      try { const d = JSON.parse(body || "{}"); console.log("[QA] " + String(d.msg || "").slice(0, 400)); } catch {}
      res.writeHead(204); res.end();
    });
    return;
  }
  if (req.url === "/api/run-lint" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      try { runLint(body ? JSON.parse(body) : {}, res); }
      catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  const gitActMatch = req.url.match(/^\/api\/git\/(commit|push|pull|stash|diff|log)$/);
  if (gitActMatch && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      try {
        const d = body ? JSON.parse(body) : {};
        gitAction(gitActMatch[1], d, res);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  const gitBrMatch = req.url.match(/^\/api\/git\/branches\/(list|checkout|create|delete)$/);
  if (gitBrMatch && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => {
      try {
        const d = body ? JSON.parse(body) : {};
        gitBranchAction(gitBrMatch[1], d, res);
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }
  if (req.url === "/api/projects" && req.method === "GET") return listProjects(res);
  // Static preview server: /preview/<project>/<path>
  const previewMatch = req.url.match(/^\/preview\/([^/?#]+)(\/.*)?$/);
  if (previewMatch && req.method === "GET") {
    const projectName = decodeURIComponent(previewMatch[1]);
    const sub = decodeURIComponent((previewMatch[2] || "/").split("?")[0].split("#")[0]);
    return servePreviewFile(projectName, sub, res);
  }
  if (req.url.startsWith("/api/htmls") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return listHtmls(u.searchParams.get("path") || "", res);
  }
  if (req.url.startsWith("/api/canvas/frames") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return listCanvasFrames(u.searchParams.get("path") || "", res);
  }
  if (req.url.startsWith("/api/fs/list-dirs") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return listDirsForPicker(u.searchParams.get("path") || "/home/diogo", res);
  }
  if (req.url === "/api/ds/list" && req.method === "GET") return listDesignSystems(res);
  if (req.url === "/api/ds/link" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err || !data.target || !data.dsPath) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "target/dsPath obrigatorios" })); }
      return linkDesignSystem(data.target, data.dsPath, res);
    });
  }
  if (req.url === "/api/ds/sync" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err || !data.target) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "target obrigatorio" })); }
      return syncDesignSystem(data.target, res);
    });
  }
  if (req.url === "/api/ds/unlink" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err || !data.target) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "target obrigatorio" })); }
      return unlinkDesignSystem(data.target, res);
    });
  }
  if (req.url === "/api/ds/copy-component" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err || !data.dsPath || !data.target || !data.sourceFile) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "dsPath/target/sourceFile obrigatorios" })); }
      return copyDesignComponent(data.dsPath, data.target, data.sourceFile, res);
    });
  }
  if (req.url.startsWith("/api/ds/check") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return dsCheckDrift(u.searchParams.get("path") || "", res);
  }
  if (req.url === "/api/ds/promote" && req.method === "POST") {
    return readJsonBody(req, (err, data) => {
      if (err || !data.target || !data.file) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "target/file obrigatorios" })); }
      return promoteToDesignSystem(data.target, data.file, res);
    });
  }
  if (req.url === "/api/canvas/ensure-mount" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const d = JSON.parse(body || "{}");
        return ensureCanvasMount(d.path || "", res);
      } catch (e) {
        res.writeHead(400, {"Content-Type":"application/json"});
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  const projDelMatch = req.url.match(/^\/api\/projects\/([^\/]+)$/);
  if (projDelMatch && req.method === "DELETE") {
    return deleteProject(decodeURIComponent(projDelMatch[1]), res);
  }
  if (req.url === "/api/projects/create" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try { createProject(JSON.parse(body), res); }
      catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  // BMAD agent on-demand for an existing project (streamed via SSE)
  if (req.url === "/api/projects/run-bmad" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      let data;
      try { data = JSON.parse(body || "{}"); }
      catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: e.message }));
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      const send = (kind, payload) => { try { res.write("data: " + JSON.stringify({ kind, ...payload }) + "\n\n"); } catch {} };
      try {
        const out = await runBmadAgentForExistingProject({ projectPath: data.path, agentName: data.agent, send });
        send("done", out);
      } catch (e) {
        send("error", { error: e.message || String(e) });
      } finally {
        res.end();
      }
    });
    return;
  }
  // Dev server endpoints
  if (req.url === "/api/devserver/start" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const d = JSON.parse(body || "{}");
        const r = startDevServer(d.path);
        res.writeHead(r.error ? 400 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url === "/api/devserver/stop" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const d = JSON.parse(body || "{}");
        const r = stopDevServer(d.path);
        res.writeHead(r.error ? 400 : 200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url.startsWith("/api/devserver/status") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getDevServerState(u.searchParams.get("path") || "")));
  }
  if (req.url.startsWith("/api/devserver/logs") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ logs: getDevServerLogs(u.searchParams.get("path") || "", u.searchParams.get("max")) }));
  }
  // ── Postgres local (Docker) por projeto — dev/prod estilo Replit ──
  if (req.url === "/api/code/db/provision" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const d = JSON.parse(body || "{}");
        const safe = _safeProjectPath(d.path);
        if (!safe) throw new Error("Caminho invalido (so projetos em ~/dev/projetos)");
        const name = path.basename(safe);
        const scaffold = codeScaffold.scaffoldSupabase(safe, name);
        const dbInfo = await codeDb.provision(safe, name);
        if (!dbInfo.ok) throw new Error(dbInfo.error || "provision falhou");
        codeScaffold.writeEnvFiles(safe, "dev", dbInfo);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, db: dbInfo, scaffold }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (req.url.startsWith("/api/code/db/status") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    const safe = _safeProjectPath(u.searchParams.get("path") || "");
    if (!safe) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: "path invalido" })); }
    codeDb.status(safe).then((st) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(st));
    }).catch((e) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); });
    return;
  }
  if ((req.url === "/api/code/db/migrate" || req.url === "/api/code/db/generate" || req.url === "/api/code/db/promote" || req.url === "/api/code/db/diff" || req.url === "/api/code/db/publish" || req.url === "/api/code/db/inspect" || req.url === "/api/code/db/connect") && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const d = JSON.parse(body || "{}");
        const safe = _safeProjectPath(d.path);
        if (!safe) throw new Error("Caminho invalido");
        const name = path.basename(safe);
        let r;
        if (req.url.endsWith("/generate")) r = await codeDb.migrationNew(safe, d.name || name);
        else if (req.url.endsWith("/diff")) r = await codeDb.dbDiff(safe, d.name || "schema");
        else if (req.url.endsWith("/promote")) r = await codeDb.promote(safe);
        else if (req.url.endsWith("/publish")) r = await codeDb.publishToSchema(safe, d.schema, { dryRun: d.dryRun });
        else if (req.url.endsWith("/inspect")) r = await codeDb.dbInspect(safe, d.schema);
        else if (req.url.endsWith("/connect")) r = await codeDb.connect(safe, d.token, d.ref);
        else r = await codeDb.migrate(safe);
        res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.split("?")[0] === "/api/code/secrets" && req.method === "GET") {
    try {
      const u = new URL(req.url, "http://localhost");
      const safe = _safeProjectPath(u.searchParams.get("path"));
      if (!safe) throw new Error("Caminho invalido");
      const r = codeScaffold.readSecrets(safe, u.searchParams.get("env"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if ((req.url === "/api/code/secrets" || req.url === "/api/code/secrets/delete") && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", () => {
      try {
        const d = JSON.parse(body || "{}");
        const safe = _safeProjectPath(d.path);
        if (!safe) throw new Error("Caminho invalido");
        const r = req.url.endsWith("/delete")
          ? codeScaffold.deleteSecret(safe, d.env, d.key)
          : codeScaffold.setSecret(safe, d.env, d.key, d.value);
        res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === "/api/code/db/cloud/projects" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const d = JSON.parse(body || "{}");
        const r = await codeDb.cloudProjects(d.token);
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.url === "/api/code/db/link" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const d = JSON.parse(body || "{}");
        const safe = _safeProjectPath(d.path);
        if (!safe) throw new Error("Caminho invalido");
        const r = await codeDb.link(safe, d.ref, d.token, { name: d.name, org: d.org });
        res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.url === "/api/code/db/unlink" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const d = JSON.parse(body || "{}");
        const safe = _safeProjectPath(d.path);
        if (!safe) throw new Error("Caminho invalido");
        const r = await codeDb.unlink(safe);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.url === "/api/code/db/studio" && req.method === "POST") {
    let body = ""; req.on("data", c => body += c);
    req.on("end", async () => {
      try {
        const d = JSON.parse(body || "{}");
        const safe = _safeProjectPath(d.path);
        if (!safe) throw new Error("Caminho invalido");
        const r = await codeDb.studio(safe, path.basename(safe));
        res.writeHead(r.ok ? 200 : 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r));
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  if (req.url === "/api/hub/tree" && req.method === "GET") return hubTree(res);
  if (req.url.startsWith("/api/hub/file") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return readHubFile(u.searchParams.get("path") || "", res, u.searchParams.get("raw") === "1");
  }
  if (req.url.startsWith("/api/hub/file") && req.method === "DELETE") {
    const u = new URL(req.url, "http://localhost");
    return deleteHubFile(u.searchParams.get("path") || "", res);
  }
  if (req.url.startsWith("/api/hub/file") && req.method === "PUT") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try { updateHubFile(JSON.parse(body), res); }
      catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (req.url === "/api/hub/graph" && req.method === "GET") return hubGraph(res);
  if (req.url === "/api/hub/save" && req.method === "POST") {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try {
        saveHubNote(JSON.parse(body), res).catch(e => {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }
  if (req.url.startsWith("/api/search") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return searchInProject(u.searchParams.get("q") || "", u.searchParams.get("path") || __dirname, res);
  }
  if (req.url === "/api/terminal" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => { try { const d = JSON.parse(body); runTerminal(d.command || "", d.cwd || __dirname, res); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ output: "Erro" })); } });
    return;
  }
  if (req.url === "/api/fs" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => { try { const d = JSON.parse(body); fsAction(d.action, d, res); } catch (e) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); } });
    return;
  }

  // GET /api/uploads/:id
  const uploadMatch = req.url.match(/^\/api\/uploads\/([a-z0-9_]+)/i);
  if (uploadMatch && req.method === "GET") return serveUpload(uploadMatch[1], res);

  // ── Worker Cowork API ──
  if ((req.url === "/api/events" || req.url.startsWith("/api/events?")) && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    const workerId = u.searchParams.get("workerId") || undefined;
    workerBus.attachSSE(res, { workerId });
    return;
  }

  if ((req.url === "/api/workers" || req.url.startsWith("/api/workers?")) && req.method === "GET") {
    const u2 = new URL(req.url, "http://localhost");
    const kind = u2.searchParams.get("kind") || "worker";
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ workers: workerRegistry.list({ kind }).map((w) => w.toJSON()) }));
  }

  if (req.url === "/api/workers" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const w = workerRegistry.create({
          title: data.title,
          agentId: data.agentId,
          provider: data.provider || "ollama",
          model: data.model,
          systemPrompt: data.systemPrompt,
          cwd: data.cwd,
        });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(w.toJSON()));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  const workerMsgMatch = req.url.match(/^\/api\/workers\/([a-z0-9_]+)\/message$/i);
  if (workerMsgMatch && req.method === "POST") {
    const worker = workerRegistry.get(workerMsgMatch[1]);
    if (!worker) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Worker não encontrado" }));
    }
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const content = (data.content || data.text || "").toString();
        const attachments = Array.isArray(data.attachments) ? data.attachments : null;
        if (!content.trim() && !(attachments && attachments.length)) throw new Error("content vazio");
        const opts = {
          bmadAgent: data.bmadAgent || null,
          attachments,
          systemPromptOverride: typeof data.systemPromptOverride === "string" ? data.systemPromptOverride : null,
          historyMode: data.historyMode || "full",
          historyLimit: typeof data.historyLimit === "number" ? data.historyLimit : 6,
          temperature: typeof data.temperature === "number" ? data.temperature : undefined,
          interrupt: !!data.interrupt,
          permissionMode: typeof data.permissionMode === "string" ? data.permissionMode : null,
          effort: typeof data.effort === "string" ? data.effort : null,
        };
        const wasRunning = worker.status === "running";
        worker.sendMessage(content, opts).catch((err) => {
          console.error(`[worker ${worker.id}] sendMessage error:`, err.message);
        });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          accepted: true,
          workerId: worker.id,
          queued: wasRunning,
          interrupt: wasRunning && !!data.interrupt,
        }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  const workerPermMatch = req.url.match(/^\/api\/workers\/([a-z0-9_]+)\/permission$/i);
  if (workerPermMatch && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Repassa a decisão de permissão (allow/deny + answers) ao sidecar SDK,
      // que resolve o PreToolUse hook bloqueado.
      const payload = body || "{}";
      const fwd = http.request({
        host: "127.0.0.1", port: 3001, path: "/sdk/permission", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      }, (sr) => {
        let out = ""; sr.on("data", (c) => (out += c));
        sr.on("end", () => { res.writeHead(sr.statusCode || 200, { "Content-Type": "application/json" }); res.end(out || "{}"); });
      });
      fwd.on("error", (e) => { res.writeHead(502, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "sidecar: " + e.message })); });
      fwd.write(payload); fwd.end();
    });
    return;
  }

  const workerAbortMatch = req.url.match(/^\/api\/workers\/([a-z0-9_]+)\/abort$/i);
  if (workerAbortMatch && req.method === "POST") {
    const worker = workerRegistry.get(workerAbortMatch[1]);
    if (!worker) { res.writeHead(404); return res.end(JSON.stringify({ error: "Worker não encontrado" })); }
    worker.abort();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  const workerIdMatch = req.url.match(/^\/api\/workers\/([a-z0-9_]+)\/?$/i);
  if (workerIdMatch && req.method === "GET") {
    const worker = workerRegistry.get(workerIdMatch[1]);
    if (!worker) { res.writeHead(404); return res.end(JSON.stringify({ error: "Worker não encontrado" })); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ...worker.toJSON(), history: worker.getHistory() }));
  }
  if (workerIdMatch && req.method === "DELETE") {
    const ok = workerRegistry.remove(workerIdMatch[1]);
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok }));
  }
  if (workerIdMatch && req.method === "PATCH") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const w = workerRegistry.update(workerIdMatch[1], data);
        if (!w) { res.writeHead(404); return res.end(JSON.stringify({ error: "Worker não encontrado" })); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(w.toJSON()));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ─── Conversations (chat) ─────────────────────────────────
  if (req.url === "/api/conversations" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ conversations: chatStore.listChats() }));
  }
  if (req.url === "/api/conversations" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const c = chatStore.createChat(data);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(c));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  const convDistillMatch = req.url.match(/^\/api\/conversations\/([a-z0-9_]+)\/distill$/i);
  if (convDistillMatch && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        try { chatSnapshot.flushNow(convDistillMatch[1]); } catch {}
        const result = await chatDistill.distillConversation(convDistillMatch[1], { model: data.model });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  const convMsgsMatch = req.url.match(/^\/api\/conversations\/([a-z0-9_]+)\/messages$/i);
  if (convMsgsMatch && req.method === "GET") {
    const msgs = chatStore.getMessages(convMsgsMatch[1]);
    if (!msgs) { res.writeHead(404); return res.end(JSON.stringify({ error: "não encontrado" })); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ messages: msgs }));
  }
  if (convMsgsMatch && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const m = chatStore.appendMessage(convMsgsMatch[1], data);
        if (!m) { res.writeHead(404); return res.end(JSON.stringify({ error: "não encontrado" })); }
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(m));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (convMsgsMatch && req.method === "PUT") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const m = chatStore.replaceMessages(convMsgsMatch[1], data.messages || []);
        if (!m) { res.writeHead(404); return res.end(JSON.stringify({ error: "não encontrado" })); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: m }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  const convIdMatch = req.url.match(/^\/api\/conversations\/([a-z0-9_]+)\/?$/i);
  if (convIdMatch && req.method === "GET") {
    const c = chatStore.getChat(convIdMatch[1]);
    if (!c) { res.writeHead(404); return res.end(JSON.stringify({ error: "não encontrada" })); }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(c));
  }
  if (convIdMatch && req.method === "PATCH") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        let c;
        if (data.title !== undefined && Object.keys(data).length === 1) {
          c = chatStore.renameChat(convIdMatch[1], data.title);
        } else {
          c = chatStore.updateChatModel(convIdMatch[1], data);
        }
        if (!c) { res.writeHead(404); return res.end(JSON.stringify({ error: "não encontrada" })); }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(c));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (convIdMatch && req.method === "DELETE") {
    const ok = chatStore.deleteChat(convIdMatch[1]);
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok }));
  }

  if (req.url === "/api/migrate-chat" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const data = JSON.parse(body || "{}");
        const result = chatStore.migrateFromLocalStorage(data);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const data = JSON.parse(body);
        const provider = data.provider || "ollama";
        const model = data.model || "contpix";
        let messages = data.messages || [];
        const stream = data.stream || false;
        let systemPrompt = data.systemPrompt || "";
        const temperature = typeof data.temperature === "number" ? data.temperature : undefined;
        const historyMode = data.historyMode || "full";
        const historyLimit = data.historyLimit || 6;
        const useRAG = data.useRAG !== false;

        // Apply history mode filtering
        if (historyMode === "none" && messages.length > 0) {
          messages = [messages[messages.length - 1]];
        } else if (historyMode === "limited" && messages.length > historyLimit) {
          messages = messages.slice(-historyLimit);
        }

        // RAG: inject relevant vault context into system prompt
        let ragNotes = [];
        let ragSource = "none";
        if (useRAG && messages.length > 0) {
          const lastUser = [...messages].reverse().find(m => m.role === "user");
          if (lastUser && typeof lastUser.content === "string" && lastUser.content.trim()) {
            ragNotes = await findHubContextSemantic(lastUser.content, 3, data.cwd);
            if (ragNotes.length) ragSource = "semantic";
            else { ragNotes = findHubContext(lastUser.content, 3, data.cwd); if (ragNotes.length) ragSource = "keyword"; }
            if (ragNotes.length) {
              const ctxBlock = ragNotes.map(n =>
                `### ${n.path}\n${n.content.slice(0, 1500)}`
              ).join("\n\n---\n\n");
              const ragPreamble = "Voce tem acesso ao vault de conhecimento do usuario (notas pessoais, snippets, ADRs). Use as notas abaixo como contexto se relevante. Se nao for relevante para a pergunta, ignore.\n\n=== NOTAS DO VAULT ===\n\n" + ctxBlock + "\n\n=== FIM DAS NOTAS ===\n\n";
              systemPrompt = ragPreamble + (systemPrompt || "");
            }
          }
        }

        console.log("[chat]", { provider, model, hasSystem: !!systemPrompt, historyMode, msgCount: messages.length, ragHits: ragNotes.length, ragSource });

        // Emit context event before LLM stream (so UI can show "N notas usadas")
        if (stream && ragNotes.length) {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
          sseWrite(res, { kind: "context", source: ragSource, notes: ragNotes.map(n => ({ path: n.path, score: Math.round(n.score * 1000) / 1000, matchedTerms: n.matchedTerms || [], snippet: n.snippet || "", reason: n.reason || "" })) });
          // call chat without re-writing headers — pass a flag
          if (provider === "claude") { claudeChat(model, messages, res, stream, systemPrompt, true, data.cwd, data.permissionMode, data.effort); }
          else { ollamaChat(model, messages, res, stream, systemPrompt, temperature, true); }
          return;
        }

        if (provider === "claude") { claudeChat(model, messages, res, stream, systemPrompt, false, data.cwd, data.permissionMode, data.effort); }
        else { ollamaChat(model, messages, res, stream, systemPrompt, temperature); }
      } catch (e) {
        if (res.headersSent) {
          try { sseWrite(res, { kind: "error", message: String(e?.message || e) }); } catch {}
          try { res.end(); } catch {}
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ content: "Erro: " + e.message }));
        }
      }
    });
    return;
  }

  // Serve frontend
  const reqPath = req.url.split("?")[0];
  let filePath = reqPath === "/" ? "/index.html" : reqPath;
  filePath = path.join(__dirname, "public", filePath);
  const ext = path.extname(filePath);
  const types = { ".html":"text/html",".css":"text/css",".js":"application/javascript",".png":"image/png",".svg":"image/svg+xml",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp" };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const headers = { "Content-Type": types[ext] || "text/plain" };
    if (ext === ".html" || ext === ".js" || ext === ".css") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Nook Studio rodando em http://localhost:${PORT}`);
  setImmediate(() => runStartupDiagnostics().catch(() => {}));
});

async function collectDiagnostics() {
  const checks = [];
  const which = (cmd) => new Promise((r) => {
    const p = require("child_process").spawn("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    let out = ""; p.stdout.on("data", (c) => out += c); p.on("close", () => r(out.trim() || null));
    p.on("error", () => r(null));
  });

  const [wmctrl, xdotool, claudeBin, chromium, chromiumBrowser, chrome] = await Promise.all([
    which("wmctrl"), which("xdotool"), which("claude"),
    which("chromium"), which("chromium-browser"), which("google-chrome"),
  ]);
  const browser = chromium || chromiumBrowser || chrome;
  checks.push({ name: "claude CLI", status: claudeBin ? "ok" : "fail", detail: claudeBin || "não encontrado no PATH" });
  checks.push({ name: "wmctrl + xdotool", status: (wmctrl && xdotool) ? "ok" : "warn", detail: (wmctrl && xdotool) ? "OK" : "Super+J não funciona — sudo apt install wmctrl xdotool" });
  checks.push({ name: "chrome/chromium", status: browser ? "ok" : "warn", detail: browser || "browser worker pode falhar" });
  checks.push({ name: "hub vault", status: fs.existsSync(HUB_ROOT) ? "ok" : "warn", detail: HUB_ROOT });
  checks.push({ name: "projetos dir", status: fs.existsSync(PROJETOS_ROOT) ? "ok" : "warn", detail: PROJETOS_ROOT });

  try {
    const r = await fetch("http://localhost:3001/health", { signal: AbortSignal.timeout(2000) });
    checks.push({ name: "sidecar Python", status: r.ok ? "ok" : "warn", detail: r.ok ? "porta 3001" : ("HTTP " + r.status) });
  } catch { checks.push({ name: "sidecar Python", status: "warn", detail: "offline" }); }

  try {
    const r = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(1500) });
    checks.push({ name: "ollama", status: r.ok ? "ok" : "warn", detail: r.ok ? "rodando" : ("HTTP " + r.status) });
  } catch { checks.push({ name: "ollama", status: "warn", detail: "offline (RAG cai pra keyword)" }); }

  checks.push({
    name: "telegram",
    status: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? "ok" : "warn",
    detail: (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ? "configurado" : "TELEGRAM_BOT_TOKEN/CHAT_ID não setados",
  });

  // Hub stats — derivable from FS, but useful in one place
  try {
    const folders = ["snippets", "padroes", "decisoes", "memorias", "planos", "conversas"];
    const counts = folders.map(f => {
      const d = path.join(HUB_ROOT, f);
      if (!fs.existsSync(d)) return f + ":0";
      try { return f + ":" + fs.readdirSync(d).filter(n => n.endsWith(".md")).length; } catch { return f + ":?"; }
    });
    checks.push({ name: "hub stats", status: "ok", detail: counts.join(" · ") });
  } catch {}

  // Workers count
  try {
    const ws = workerRegistry.list({ kind: "worker" });
    const running = ws.filter(w => w.status === "running").length;
    checks.push({ name: "cowork workers", status: "ok", detail: ws.length + " total · " + running + " running" });
  } catch {}

  return checks;
}

async function runStartupDiagnostics() {
  const checks = await collectDiagnostics();
  const sym = { ok: "✓", warn: "⚠", fail: "✗" };
  console.log("\n[diagnostics]");
  for (const c of checks) console.log(`  ${sym[c.status] || "·"} ${c.name}${c.detail ? " — " + c.detail : ""}`);
  console.log("");
}
