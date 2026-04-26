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
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
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
function ollamaChat(model, messages, res, stream, systemPrompt, temperature) {
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
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
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
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
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
function claudeChat(model, messages, res, stream, systemPrompt) {
  const processed = processAttachmentsForClaude(messages);
  let prompt = "";
  for (const m of processed) {
    if (m.role === "user") prompt += "User: " + m.content + "\n";
    else if (m.role === "assistant") prompt += "Assistant: " + m.content + "\n";
  }

  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
  if (model) args.push("--model", model);
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);

  const startTime = Date.now();
  const t = () => ((Date.now() - startTime) / 1000).toFixed(1);
  let toolCount = 0;
  let permDenials = 0;

  console.log(`[chat t=${t()}] start model=${model} permMode=bypassPermissions`);

  const claude = spawn("claude", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

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
    sseWrite(res, { kind: "done" }); res.end();
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

// ── Git Status ──
function gitStatus(res) {
  const proc = spawn("git", ["status", "--porcelain", "-b"], { cwd: __dirname, stdio: ["ignore", "pipe", "pipe"] });
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
      files.push({ status, name, path: path.join(__dirname, name) });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ branch, files }));
  });
  proc.on("error", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ branch: "", files: [] })); });
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

// ── Server ──
const server = http.createServer({ requestTimeout: 0, headersTimeout: 0 }, (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.url === "/api/status/claude" && req.method === "GET") return checkClaudeStatus(res);
  if (req.url === "/api/ollama/models" && req.method === "GET") return fetchOllamaModels(res);
  if (req.url === "/api/upload" && req.method === "POST") return handleUpload(req, res);

  // File browser (Code Mode)
  if (req.url.startsWith("/api/files") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return listFiles(u.searchParams.get("path") || __dirname, res);
  }
  if (req.url.startsWith("/api/file-content") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return readFileContent(u.searchParams.get("path") || "", res);
  }
  if (req.url === "/api/git-status" && req.method === "GET") return gitStatus(res);
  if (req.url.startsWith("/api/search") && req.method === "GET") {
    const u = new URL(req.url, "http://localhost");
    return searchInProject(u.searchParams.get("q") || "", u.searchParams.get("path") || __dirname, res);
  }
  if (req.url === "/api/terminal" && req.method === "POST") {
    let body = ""; req.on("data", c => (body += c));
    req.on("end", () => { try { const d = JSON.parse(body); runTerminal(d.command || "", d.cwd || __dirname, res); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ output: "Erro" })); } });
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
        };
        worker.sendMessage(content, opts).catch((err) => {
          console.error(`[worker ${worker.id}] sendMessage error:`, err.message);
        });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true, workerId: worker.id }));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
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
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        const provider = data.provider || "ollama";
        const model = data.model || "contpix";
        let messages = data.messages || [];
        const stream = data.stream || false;
        const systemPrompt = data.systemPrompt || "";
        const temperature = typeof data.temperature === "number" ? data.temperature : undefined;
        const historyMode = data.historyMode || "full";
        const historyLimit = data.historyLimit || 6;

        // Apply history mode filtering
        if (historyMode === "none" && messages.length > 0) {
          messages = [messages[messages.length - 1]];
        } else if (historyMode === "limited" && messages.length > historyLimit) {
          messages = messages.slice(-historyLimit);
        }

        console.log("[chat]", { provider, model, hasSystem: !!systemPrompt, historyMode, msgCount: messages.length });

        if (provider === "claude") { claudeChat(model, messages, res, stream, systemPrompt); }
        else { ollamaChat(model, messages, res, stream, systemPrompt, temperature); }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: "Erro: " + e.message }));
      }
    });
    return;
  }

  // Serve frontend
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, "public", filePath);
  const ext = path.extname(filePath);
  const types = { ".html":"text/html",".css":"text/css",".js":"application/javascript",".png":"image/png",".svg":"image/svg+xml",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp" };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
    res.end(data);
  });
});

server.listen(PORT, "0.0.0.0", () => { console.log(`Jarvis Hub rodando em http://localhost:${PORT}`); });
