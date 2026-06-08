const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// Banco dos projetos do Código mode = Supabase NATIVE, um projeto Supabase por app.
// Orquestramos a CLI `supabase` (instalada global) no diretório do projeto — sem dep
// nova no Hub. Local: um stack por vez (portas 5432x são fixas e colidem). Migrations
// = CLI do Supabase (supabase/migrations = fonte oficial). Prod: `supabase link` +
// `supabase db push`.

const LOCAL_STUDIO_URL = process.env.JARVIS_SUPABASE_STUDIO_URL || "http://127.0.0.1:54323";
const LOCAL_API_URL = process.env.JARVIS_SUPABASE_API_URL || "http://127.0.0.1:54321";

function sanitize(name) {
  let s = String(name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/^([0-9])/, "p$1");
  s = s.replace(/[-_]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return s.slice(0, 48) || "proj";
}

// Roda um comando arbitrário e resolve {ok,out,err,code}. spawn sem shell — args
// vão como argv, sem risco de injeção.
function runCmd(cmd, args, opts) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, Object.assign({ stdio: ["ignore", "pipe", "pipe"] }, opts || {}));
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code }));
    proc.on("error", (e) => resolve({ ok: false, out: "", err: e.message, code: -1 }));
  });
}

function runSupabase(projectPath, args, extraEnv) {
  return runCmd("supabase", args, {
    cwd: projectPath,
    env: Object.assign({}, process.env, extraEnv || {}),
  });
}

function hasSupabaseDir(projectPath) {
  return fs.existsSync(path.join(projectPath, "supabase", "config.toml"));
}

function dbContainer(projectPath) {
  return "supabase_db_" + sanitize(path.basename(projectPath));
}

function migrationsCount(projectPath) {
  try {
    return fs.readdirSync(path.join(projectPath, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).length;
  } catch { return 0; }
}

// Estado da PRODUÇÃO (Supabase Cloud). `supabase link` grava o ref em
// supabase/.temp/project-ref. Sem dep de rede — só lê o arquivo. Se não linkado,
// prod ainda não foi conectado (fluxo de prod é por-projeto, à parte do dev local).
function prodInfo(projectPath) {
  try {
    const ref = fs.readFileSync(path.join(projectPath, "supabase", ".temp", "project-ref"), "utf8").trim();
    if (ref) return { linked: true, ref, dashboardUrl: "https://supabase.com/dashboard/project/" + ref };
  } catch {}
  return { linked: false };
}

// Acrescenta o MCP de PROD (Cloud) ao .mcp.json do projeto, sem apagar o "supabase"
// local (dev). Assim o agente tem as duas opções depois de conectar prod.
function writeProdMcp(projectPath, ref) {
  const p = path.join(projectPath, ".mcp.json");
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
  if (!cfg || typeof cfg !== "object") cfg = {};
  if (!cfg.mcpServers) cfg.mcpServers = {};
  cfg.mcpServers["supabase-prod"] = { type: "http", url: "https://mcp.supabase.com/mcp?project_ref=" + ref };
  try { fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n"); } catch {}
}

// Contagem de tabelas do schema public (só um número pro dashboard — não é viewer).
async function tablesCount(projectPath) {
  const r = await runCmd("docker", ["exec", dbContainer(projectPath), "psql", "-U", "postgres", "-d", "postgres", "-tAc",
    "select count(*) from information_schema.tables where table_schema='public';"]);
  return r.ok ? (parseInt(r.out, 10) || 0) : null;
}

// Fixa project_id no config.toml pra namespiar os containers (supabase_*_<id>) por
// projeto — sem isso dois projetos colidiriam no mesmo namespace.
function _setProjectId(projectPath, id) {
  const cfg = path.join(projectPath, "supabase", "config.toml");
  try {
    let txt = fs.readFileSync(cfg, "utf8");
    if (/^project_id\s*=/m.test(txt)) txt = txt.replace(/^project_id\s*=.*$/m, 'project_id = "' + id + '"');
    else txt = 'project_id = "' + id + '"\n' + txt;
    fs.writeFileSync(cfg, txt);
  } catch {}
}

// `supabase init` idempotente + project_id.
async function init(projectPath, name) {
  if (!hasSupabaseDir(projectPath)) {
    const r = await runSupabase(projectPath, ["init"]);
    if (!hasSupabaseDir(projectPath)) {
      throw new Error("supabase init falhou: " + (r.err || r.out || "code " + r.code));
    }
  }
  _setProjectId(projectPath, sanitize(name));
  return { ok: true };
}

// Para TODOS os containers supabase rodando (stop, não rm — volumes/dados ficam
// intactos). Necessário porque as portas (54321-54324) são fixas: só um stack roda
// por vez. `supabase start` recria os containers deste projeto a partir do volume.
async function _stopRunningStacks() {
  const r = await runCmd("docker", ["ps", "-q", "--filter", "name=supabase_"]);
  const ids = (r.out || "").split("\n").map((s) => s.trim()).filter(Boolean);
  if (ids.length) await runCmd("docker", ["stop"].concat(ids));
  return ids.length;
}

// Sobe o stack do projeto (parando qualquer outro antes) e devolve as keys.
async function start(projectPath, name) {
  if (!hasSupabaseDir(projectPath)) return { ok: false, error: "projeto sem supabase/ — provisione primeiro" };
  await _stopRunningStacks();
  const r = await runSupabase(projectPath, ["start"]);
  if (!r.ok) return { ok: false, up: false, error: (r.err || r.out || "code " + r.code).slice(-4000) };
  return status(projectPath);
}

function _parseEnv(text) {
  const o = {};
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

// `supabase status -o env` → {ok, up, url, anonKey, serviceRoleKey, dbUrl, studioUrl}.
// Se o stack não estiver de pé, up=false (sem erro — é estado normal).
async function status(projectPath) {
  if (!hasSupabaseDir(projectPath)) return { ok: false, up: false, error: "projeto sem supabase/ (provisione)" };
  const migrations = migrationsCount(projectPath);
  const prod = prodInfo(projectPath);
  const r = await runSupabase(projectPath, ["status", "-o", "env"]);
  if (!r.ok) return { ok: true, up: false, studioUrl: LOCAL_STUDIO_URL, migrations, prod };
  const e = _parseEnv(r.out);
  return {
    ok: true,
    up: true,
    url: e.API_URL || e.SUPABASE_URL || LOCAL_API_URL,
    anonKey: e.ANON_KEY || e.SUPABASE_ANON_KEY || "",
    serviceRoleKey: e.SERVICE_ROLE_KEY || e.SUPABASE_SERVICE_ROLE_KEY || "",
    dbUrl: e.DB_URL || e.DATABASE_URL || "",
    studioUrl: e.STUDIO_URL || LOCAL_STUDIO_URL,
    tables: await tablesCount(projectPath),
    migrations,
    prod,
  };
}

// Provisiona o projeto: init + start. Retorna as keys do ambiente local (pro Hub
// escrever o .env). O scaffold dos arquivos da app é separado (lib/code/scaffold).
async function provision(projectPath, name) {
  await init(projectPath, name);
  const started = await start(projectPath, name);
  if (!started.up) return { ok: false, error: started.error || "supabase start falhou" };
  return Object.assign({ ok: true }, started);
}

// Cria uma migration SQL vazia (o agente preenche o DDL). Fonte oficial de schema.
async function migrationNew(projectPath, name) {
  const slug = String(name || "update").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "update";
  const r = await runSupabase(projectPath, ["migration", "new", slug]);
  return { ok: r.ok, out: r.out, err: r.err, migration: slug };
}

// Captura mudanças feitas VISUAL no Studio numa migration (fonte do schema).
// `supabase db diff -f` compara o banco local com as migrations e grava o delta
// num novo arquivo SQL — assim o que o usuário criou no Table Editor vira algo
// reproduzível em prod, sem escrever SQL na mão.
async function dbDiff(projectPath, name) {
  const slug = String(name || "schema").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "schema";
  const r = await runSupabase(projectPath, ["db", "diff", "-f", slug]);
  const log = (r.out + "\n" + r.err).trim();
  // "No schema changes found" = nada pra capturar (não é erro de verdade).
  const nothing = /no schema changes/i.test(log);
  return { ok: r.ok, nothing, out: r.out, err: r.err, log: log.slice(-8000), migration: slug };
}

// Aplica migrations pendentes no banco LOCAL (não-destrutivo).
async function migrate(projectPath) {
  const r = await runSupabase(projectPath, ["migration", "up", "--local"]);
  return { ok: r.ok, out: r.out, err: r.err, log: (r.out + "\n" + r.err).trim().slice(-8000) };
}

// Conecta o projeto a um projeto Supabase Cloud de PRODUÇÃO (1x). Requer
// `supabase login` feito antes (token do dono). Grava o ref em supabase/.temp.
async function link(projectPath, ref) {
  const clean = String(ref || "").trim();
  if (!/^[a-z0-9]{15,30}$/i.test(clean)) return { ok: false, error: "project-ref inválido" };
  const r = await runSupabase(projectPath, ["link", "--project-ref", clean]);
  if (r.ok) writeProdMcp(projectPath, clean);
  return { ok: r.ok, error: r.ok ? undefined : (r.err || r.out || "falhou — fez supabase login?").slice(-2000), log: (r.out + "\n" + r.err).trim().slice(-8000), ref: clean };
}

// Promove pro projeto Supabase de PROD já linkado (db push aplica as migrations).
async function promote(projectPath) {
  const r = await runSupabase(projectPath, ["db", "push"]);
  return { ok: r.ok, out: r.out, err: r.err, log: (r.out + "\n" + r.err).trim().slice(-8000) };
}

// Garante o stack de pé e devolve a URL do Supabase Studio (inspeção/observabilidade).
async function studio(projectPath, name) {
  let st = await status(projectPath);
  if (st.ok && !st.up) st = await start(projectPath, name);
  if (!st.up) return { ok: false, error: st.error || "não foi possível subir o Supabase" };
  return { ok: true, url: st.studioUrl || LOCAL_STUDIO_URL };
}

module.exports = {
  status, provision,
  migrationNew, dbDiff, migrate, link, promote, studio,
};
