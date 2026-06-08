const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// Banco dos projetos do Código mode = Supabase NATIVE, um projeto Supabase por app.
// Orquestramos a CLI `supabase` (instalada global) no diretório do projeto — sem dep
// nova no Hub. Local: um stack por vez (portas 5432x são fixas e colidem). Migrations
// = CLI do Supabase (supabase/migrations = fonte oficial). Prod: `supabase link` +
// `supabase db push`.

const LOCAL_STUDIO_URL = process.env.NOOK_SUPABASE_STUDIO_URL || "http://127.0.0.1:54323";
const LOCAL_API_URL = process.env.NOOK_SUPABASE_API_URL || "http://127.0.0.1:54321";

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
    if (ref) {
      // "Conectado" exige a credencial POR PROJETO (token), não só o ref. Projeto
      // linkado pelo método antigo (login global) tem ref mas não tem token → pede reconnect.
      const hasToken = !!readProdToken(projectPath);
      const meta = readProdMeta(projectPath);
      return { linked: hasToken, ref, hasToken, name: meta.name || "", org: meta.org || "", lastPublish: meta.lastPublish || null, dashboardUrl: "https://supabase.com/dashboard/project/" + ref };
    }
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

// Remove o MCP de prod do .mcp.json (mantém o "supabase" local).
function removeProdMcp(projectPath) {
  const p = path.join(projectPath, ".mcp.json");
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    if (cfg && cfg.mcpServers && cfg.mcpServers["supabase-prod"]) {
      delete cfg.mcpServers["supabase-prod"];
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    }
  } catch {}
}

// Credencial de PROD é POR PROJETO (token do dono do projeto), nunca o login global
// da máquina. Guardado em supabase/.temp/ (gitignored) e passado via
// SUPABASE_ACCESS_TOKEN por-comando. No produto, vira store por-usuário (OAuth).
const MGMT_API = "https://api.supabase.com/v1";

function _prodTokenPath(projectPath) {
  return path.join(projectPath, "supabase", ".temp", "nook-access-token");
}
function writeProdToken(projectPath, token) {
  const p = _prodTokenPath(projectPath);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, String(token || "").trim(), { mode: 0o600 }); } catch {}
}
function readProdToken(projectPath) {
  try { return fs.readFileSync(_prodTokenPath(projectPath), "utf8").trim(); } catch { return ""; }
}

// Meta do destino de prod (nome do projeto + org) — só pra exibir "conectado a X".
function _prodMetaPath(projectPath) { return path.join(projectPath, "supabase", ".temp", "nook-prod-meta.json"); }
function writeProdMeta(projectPath, meta) {
  try { fs.mkdirSync(path.dirname(_prodMetaPath(projectPath)), { recursive: true }); fs.writeFileSync(_prodMetaPath(projectPath), JSON.stringify(meta || {})); } catch {}
}
function readProdMeta(projectPath) {
  try { return JSON.parse(fs.readFileSync(_prodMetaPath(projectPath), "utf8")) || {}; } catch { return {}; }
}

// Lista os projetos Supabase Cloud do dono do token (Management API). NÃO guarda
// nada — é só pra montar o dropdown de "escolher projeto" na conexão.
async function cloudProjects(token) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, error: "token vazio" };
  const headers = { Authorization: "Bearer " + t };
  try {
    const [pr, orgr] = await Promise.all([
      fetch(MGMT_API + "/projects", { headers }),
      fetch(MGMT_API + "/organizations", { headers }),
    ]);
    if (pr.status === 401) return { ok: false, error: "token inválido (401) — confira o access token" };
    if (!pr.ok) return { ok: false, error: "Management API retornou " + pr.status };
    const list = await pr.json();
    const orgs = orgr.ok ? await orgr.json() : [];
    const orgMap = {};
    (Array.isArray(orgs) ? orgs : []).forEach((o) => { orgMap[o.id] = o.name; });
    const projects = (Array.isArray(list) ? list : []).map((p) => ({
      ref: p.id, name: p.name, region: p.region, org: orgMap[p.organization_id] || p.organization_id,
    }));
    return { ok: true, projects, orgs: (Array.isArray(orgs) ? orgs : []).map((o) => o.name).filter(Boolean) };
  } catch (e) { return { ok: false, error: e.message }; }
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
  if (!r.ok) return { ok: true, up: false, studioUrl: LOCAL_STUDIO_URL, migrations, migrationsInfo: migrationsInfo(projectPath), prod };
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
    migrationsInfo: migrationsInfo(projectPath),
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

// Nome de schema válido pro Postgres: minúsculo, [a-z0-9_], começa com letra.
function _schemaName(s) {
  s = String(s || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^[^a-z]+/, "");
  return s.slice(0, 48);
}

// Lê as migrations e extrai os schemas que elas tocam (informativo, pro confirm de
// promote). Regex sobre o SQL — frágil de propósito, é só pra exibir "vai em: public, X".
function migrationsInfo(projectPath) {
  const dir = path.join(projectPath, "supabase", "migrations");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(); } catch {}
  const schemas = new Set();
  for (const f of files) {
    let sql = "";
    try { sql = fs.readFileSync(path.join(dir, f), "utf8"); } catch {}
    let m;
    const reSchema = /create\s+schema\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi;
    while ((m = reSchema.exec(sql))) schemas.add(m[1]);
    const reQualified = /\b(?:create\s+table|alter\s+table|create\s+(?:or\s+replace\s+)?view)\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?\s*\./gi;
    while ((m = reQualified.exec(sql))) schemas.add(m[1]);
    if (/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?"?[a-z0-9_]+"?\s*\(/i.test(sql)) schemas.add("public");
  }
  return { files: files, count: files.length, schemas: Array.from(schemas).sort() };
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
async function link(projectPath, ref, token, meta) {
  const clean = String(ref || "").trim();
  if (!/^[a-z0-9]{15,30}$/i.test(clean)) return { ok: false, error: "project-ref inválido" };
  const t = String(token || "").trim();
  if (!t) return { ok: false, error: "token de acesso ausente (conecte o Supabase primeiro)" };
  const r = await runSupabase(projectPath, ["link", "--project-ref", clean], { SUPABASE_ACCESS_TOKEN: t });
  if (r.ok) {
    writeProdToken(projectPath, t);
    writeProdMcp(projectPath, clean);
    writeProdMeta(projectPath, { ref: clean, name: (meta && meta.name) || "", org: (meta && meta.org) || "" });
  }
  return { ok: r.ok, error: r.ok ? undefined : (r.err || r.out || "falhou").slice(-2000), log: (r.out + "\n" + r.err).trim().slice(-8000), ref: clean };
}

// Conecta prod a partir SÓ de um access token (fluxo do chat: o usuário cola o token no
// assistente e ele configura o Prod-Cloud). Resolve o projeto: usa `ref` se vier; senão
// auto-escolhe quando há 1 só ou quando o nome bate com o do projeto; senão devolve a
// lista pra perguntar qual. Reusa o `link` testado (grava token/ref/meta/MCP por projeto).
async function connect(projectPath, token, ref) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, error: "token vazio" };
  const cp = await cloudProjects(t);
  if (!cp.ok) return { ok: false, error: cp.error || "não foi possível listar os projetos" };
  const projects = cp.projects || [];
  if (!projects.length) return { ok: false, error: "nenhum projeto Supabase nessa conta" };
  let pick = null;
  const cleanRef = String(ref || "").trim();
  if (cleanRef) {
    pick = projects.filter((p) => p.ref === cleanRef)[0] || null;
    if (!pick) return { ok: false, error: "ref '" + cleanRef + "' não está nessa conta" };
  } else if (projects.length === 1) {
    pick = projects[0];
  } else {
    const base = sanitize(path.basename(projectPath)).replace(/-/g, "");
    const matches = projects.filter((p) => sanitize(p.name).replace(/-/g, "") === base);
    if (matches.length === 1) pick = matches[0];
  }
  if (!pick) return { ok: true, needsPick: true, projects: projects.map((p) => ({ ref: p.ref, name: p.name, org: p.org })) };
  const lr = await link(projectPath, pick.ref, t, { name: pick.name, org: pick.org });
  if (!lr.ok) return { ok: false, error: lr.error || "falha ao linkar" };
  return { ok: true, connected: true, ref: pick.ref, name: pick.name, org: pick.org };
}

// Desconecta a produção: remove a credencial por-projeto (token/ref/meta) e o MCP
// de prod, e desfaz o link da CLI. NÃO apaga nada no Cloud — só o vínculo local.
async function unlink(projectPath) {
  try { fs.unlinkSync(_prodTokenPath(projectPath)); } catch {}
  try { fs.unlinkSync(_prodMetaPath(projectPath)); } catch {}
  await runSupabase(projectPath, ["unlink"]).catch(function () {});
  try { fs.unlinkSync(path.join(projectPath, "supabase", ".temp", "project-ref")); } catch {}
  removeProdMcp(projectPath);
  return { ok: true };
}

// Promove pro projeto de PROD linkado (db push aplica as migrations). Usa o token
// GUARDADO do projeto (per-project), nunca o login global da máquina.
async function promote(projectPath) {
  const t = readProdToken(projectPath);
  if (!t) return { ok: false, error: "produção não conectada (sem token do projeto) — reconecte na aba Prod" };
  const r = await runSupabase(projectPath, ["db", "push"], { SUPABASE_ACCESS_TOKEN: t });
  return { ok: r.ok, out: r.out, err: r.err, log: (r.out + "\n" + r.err).trim().slice(-8000) };
}

// Roda SQL arbitrário no projeto de prod via Management API (endpoint de query). Reusa
// o access token por-projeto — sem precisar da senha do banco.
async function _mgmtQuery(ref, token, sql) {
  try {
    const res = await fetch(MGMT_API + "/projects/" + ref + "/database/query", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ query: sql }),
    });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) { return { ok: false, status: 0, data: e.message }; }
}
function _mgmtErr(r) {
  const d = r && r.data;
  return (d && (d.message || d.error)) || (typeof d === "string" ? d : JSON.stringify(d)) || ("HTTP " + (r && r.status));
}
function _sqlLit(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
// Neutraliza o qualificador `public.` pra o search_path do schema-alvo resolver o destino.
function _stripPublicSchema(sql) {
  return sql.replace(/"public"\s*\./gi, "").replace(/\bpublic\s*\./gi, "");
}

// Publica num SCHEMA da prod COMPARTILHADA (sem db push). Cada app fica no seu schema,
// com histórico isolado em <schema>.nook_migrations — não colide com os outros apps do
// mesmo projeto Supabase. Tira o `public.` das migrations e aplica com search_path no
// schema. dryRun=true só calcula o que falta (não escreve nada na prod).
async function publishToSchema(projectPath, schema, opts) {
  const token = readProdToken(projectPath);
  if (!token) return { ok: false, error: "produção não conectada (sem token do projeto) — reconecte na aba Prod" };
  const info = prodInfo(projectPath);
  if (!info.ref) return { ok: false, error: "prod não linkada (sem project-ref)" };
  const sch = _schemaName(schema || path.basename(projectPath));
  if (!sch) return { ok: false, error: "schema inválido" };
  const dryRun = !!(opts && opts.dryRun);

  const dir = path.join(projectPath, "supabase", "migrations");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort(); } catch {}
  if (!files.length) return { ok: false, error: "sem migrations pra publicar" };

  if (dryRun) {
    // Sem escrever: só lista o que existe (não dá pra saber o aplicado sem tocar a prod).
    return { ok: true, schema: sch, ref: info.ref, files, dryRun: true };
  }

  // 1) schema + tabela de histórico (idempotente)
  const setup = 'create schema if not exists "' + sch + '";\n'
    + 'create table if not exists "' + sch + '".nook_migrations (version text primary key, applied_at timestamptz not null default now());';
  const s = await _mgmtQuery(info.ref, token, setup);
  if (!s.ok) return { ok: false, schema: sch, error: "falha ao preparar o schema: " + _mgmtErr(s) };

  // 2) versões já aplicadas
  const q = await _mgmtQuery(info.ref, token, 'select version from "' + sch + '".nook_migrations;');
  const applied = new Set((q.ok && Array.isArray(q.data)) ? q.data.map((r) => r.version) : []);
  const pending = files.filter((f) => !applied.has(f.replace(/\.sql$/, "")));
  if (!pending.length) {
    _recordPublish(projectPath, sch, 0, files.length);
    return { ok: true, schema: sch, ref: info.ref, applied: [], pending: [], message: "Prod já está em dia — nada novo." };
  }

  // 3) aplica cada pendente, atômico (begin/commit), registrando no histórico
  const done = [];
  for (const f of pending) {
    const version = f.replace(/\.sql$/, "");
    let sql = "";
    try { sql = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    const wrapped = "begin;\n"
      + 'set local search_path to "' + sch + '", public;\n'
      + _stripPublicSchema(sql) + "\n"
      + 'insert into "' + sch + '".nook_migrations(version) values (' + _sqlLit(version) + ');\n'
      + "commit;";
    const r = await _mgmtQuery(info.ref, token, wrapped);
    if (!r.ok) return { ok: false, schema: sch, applied: done, failedAt: f, error: _mgmtErr(r) };
    done.push(f);
  }
  _recordPublish(projectPath, sch, done.length, files.length);
  return { ok: true, schema: sch, ref: info.ref, applied: done, pending: [] };
}

// Grava a última publicação no meta de prod (pro pane mostrar onde/quando publicou).
function _recordPublish(projectPath, schema, applied, total) {
  const meta = readProdMeta(projectPath);
  meta.lastPublish = { schema, applied, total, at: Date.now() };
  writeProdMeta(projectPath, meta);
}

// ── Inspeção de estrutura (tabelas/colunas/linhas) pra comparar dev × prod ──
function _colSql(schema) {
  return "select table_name, column_name, data_type from information_schema.columns where table_schema = " + _sqlLit(schema) + " order by table_name, ordinal_position";
}
function _countSql(schema, tables) {
  if (!tables.length) return null;
  return tables.map((t) => "select " + _sqlLit(t) + ' as tbl, count(*)::bigint as rows from "' + schema + '"."' + t + '"').join(" union all ");
}
function _normalizeInspect(schema, colRows, countRows) {
  const map = {};
  (colRows || []).forEach((c) => {
    if (!map[c.table_name]) map[c.table_name] = { name: c.table_name, columns: [], rows: null };
    map[c.table_name].columns.push({ name: c.column_name, type: c.data_type });
  });
  (countRows || []).forEach((c) => { if (map[c.tbl]) map[c.tbl].rows = Number(c.rows); });
  const tables = Object.keys(map).sort().map((k) => map[k]);
  return {
    schema,
    tables,
    totals: {
      tables: tables.length,
      columns: tables.reduce((a, t) => a + t.columns.length, 0),
      rows: tables.reduce((a, t) => a + (t.rows || 0), 0),
    },
  };
}
async function _localJson(projectPath, sql) {
  const r = await runCmd("docker", ["exec", dbContainer(projectPath), "psql", "-U", "postgres", "-d", "postgres", "-tAc", sql]);
  if (!r.ok) return null;
  try { return JSON.parse(r.out || "[]"); } catch { return null; }
}
async function _inspectLocal(projectPath, schema) {
  const cols = await _localJson(projectPath, "select coalesce(json_agg(x), '[]') from (" + _colSql(schema) + ") x");
  if (cols == null) return null;
  const tables = Array.from(new Set(cols.map((c) => c.table_name)));
  const cSql = _countSql(schema, tables);
  const counts = cSql ? (await _localJson(projectPath, "select coalesce(json_agg(x), '[]') from (" + cSql + ") x") || []) : [];
  return _normalizeInspect(schema, cols, counts);
}
async function _inspectProd(ref, token, schema) {
  const cq = await _mgmtQuery(ref, token, _colSql(schema));
  if (!cq.ok || !Array.isArray(cq.data)) return null;
  const cols = cq.data.filter((c) => c.table_name !== "nook_migrations"); // infra, não é tabela do app
  const tables = Array.from(new Set(cols.map((c) => c.table_name)));
  const cSql = _countSql(schema, tables);
  let counts = [];
  if (cSql) { const rq = await _mgmtQuery(ref, token, cSql); if (rq.ok && Array.isArray(rq.data)) counts = rq.data; }
  return _normalizeInspect(schema, cols, counts);
}

// Compara a estrutura do dev (public) com a do schema publicado em prod e aponta o que
// falta em prod (tabela ou coluna) — pega o caso "esqueci de aplicar a coluna em prod".
async function dbInspect(projectPath, schema) {
  const dev = await _inspectLocal(projectPath, "public");
  const info = prodInfo(projectPath);
  const token = readProdToken(projectPath);
  const prodSchema = _schemaName(schema || (info.lastPublish && info.lastPublish.schema) || path.basename(projectPath));
  let prod = null;
  if (info.ref && token) prod = await _inspectProd(info.ref, token, prodSchema);
  let drift = null;
  if (dev && prod) {
    const pCols = {};
    prod.tables.forEach((t) => { pCols[t.name] = new Set(t.columns.map((c) => c.name)); });
    const missingTables = [];
    const missingColumns = [];
    dev.tables.forEach((t) => {
      if (!pCols[t.name]) { missingTables.push(t.name); return; }
      const miss = t.columns.filter((c) => !pCols[t.name].has(c.name)).map((c) => c.name);
      if (miss.length) missingColumns.push({ table: t.name, columns: miss });
    });
    drift = { missingTables, missingColumns, inSync: !missingTables.length && !missingColumns.length };
  }
  return { ok: true, dev, prod, prodSchema, linked: !!(info.ref && token), drift };
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
  migrationNew, dbDiff, migrate, cloudProjects, link, connect, unlink, promote, publishToSchema, dbInspect, studio,
};
