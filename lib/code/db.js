const { spawn } = require("child_process");

// Postgres local em Docker (container persistente jarvis-pg). Cada projeto do
// Código mode ganha 2 bancos no mesmo server: <proj>_dev e <proj>_prod.
// Separação dev/prod estilo Replit: mesma instância, bancos isolados, e o
// DATABASE_URL injetado por ambiente. Sem dep nova no Hub — usa `docker exec`.
const CONTAINER = process.env.JARVIS_PG_CONTAINER || "jarvis-pg";
const PG_USER = process.env.JARVIS_PG_USER || "postgres";
const PG_PASSWORD = process.env.JARVIS_PG_PASSWORD || "jarvis";
const PG_HOST = process.env.JARVIS_PG_HOST || "localhost";
const PG_PORT = process.env.JARVIS_PG_PORT || "5432";

function sanitize(name) {
  let s = String(name || "").toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^([0-9])/, "_$1");
  s = s.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return s.slice(0, 48) || "proj";
}

function dbName(project, env) {
  const e = (env === "prod" || env === "production") ? "prod" : "dev";
  return sanitize(project) + "_" + e;
}

function connString(project, env, opts) {
  const h = (opts && opts.host) || PG_HOST;
  return "postgresql://" + PG_USER + ":" + PG_PASSWORD + "@" + h + ":" + PG_PORT + "/" + dbName(project, env);
}

// Roda um SQL via psql dentro do container. Resolve {ok, out, err, code}.
function dockerPsql(sql, dbArg) {
  return new Promise((resolve) => {
    const args = ["exec", CONTAINER, "psql", "-U", PG_USER];
    if (dbArg) args.push("-d", dbArg);
    args.push("-tAc", sql);
    const proc = spawn("docker", args, { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("close", (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim(), code }));
    proc.on("error", (e) => resolve({ ok: false, out: "", err: e.message, code: -1 }));
  });
}

async function ensureContainer() {
  const r = await dockerPsql("select 1;");
  return r.ok;
}

async function createDb(name) {
  const exists = await dockerPsql("SELECT 1 FROM pg_database WHERE datname='" + name + "';");
  if (exists.ok && exists.out === "1") return { created: false };
  const r = await dockerPsql("CREATE DATABASE " + name + ";");
  if (!r.ok) throw new Error("CREATE DATABASE " + name + " falhou: " + (r.err || ("code " + r.code)));
  return { created: true };
}

// Idempotente: garante <proj>_dev e <proj>_prod. Retorna metadados + conn strings.
async function provision(project) {
  if (!(await ensureContainer())) {
    throw new Error("container '" + CONTAINER + "' indisponível (sem acesso ao docker ou container parado)");
  }
  const dev = dbName(project, "dev");
  const prod = dbName(project, "prod");
  const rDev = await createDb(dev);
  const rProd = await createDb(prod);
  return {
    container: CONTAINER, host: PG_HOST, port: PG_PORT, user: PG_USER,
    dev: { db: dev, url: connString(project, "dev"), created: rDev.created },
    prod: { db: prod, url: connString(project, "prod"), created: rProd.created },
  };
}

async function dropProject(project) {
  const dropped = [];
  for (const env of ["dev", "prod"]) {
    const n = dbName(project, env);
    const r = await dockerPsql("DROP DATABASE IF EXISTS " + n + " WITH (FORCE);");
    dropped.push({ db: n, ok: r.ok });
  }
  return dropped;
}

async function status(project) {
  const up = await ensureContainer();
  if (!up) return { container: CONTAINER, up: false };
  const out = { container: CONTAINER, up: true, host: PG_HOST, port: PG_PORT };
  for (const env of ["dev", "prod"]) {
    const n = dbName(project, env);
    const ex = await dockerPsql("SELECT 1 FROM pg_database WHERE datname='" + n + "';");
    out[env] = { db: n, exists: ex.ok && ex.out === "1", url: connString(project, env) };
  }
  return out;
}

// Lista tabelas do schema public + contagem de linhas, no banco do ambiente.
async function listTables(project, env) {
  const dbn = dbName(project, env);
  if (!(await ensureContainer())) return { ok: false, error: "container offline" };
  const r = await dockerPsql("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;", dbn);
  if (!r.ok) return { ok: false, error: r.err || ("code " + r.code) };
  const names = r.out ? r.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const tables = [];
  for (const t of names) {
    const c = await dockerPsql('SELECT count(*) FROM "' + t + '";', dbn);
    tables.push({ name: t, rows: c.ok ? parseInt(c.out, 10) : null });
  }
  return { ok: true, db: dbn, env: (env === "prod" ? "prod" : "dev"), tables };
}

// Valida identificador SQL (tabela/coluna) contra ^[a-z_][a-z0-9_]*$. A existência
// é checada contra information_schema nos helpers (defesa em profundidade).
function _ident(name) {
  const s = String(name == null ? "" : name);
  return /^[a-z_][a-z0-9_]*$/i.test(s) ? s : null;
}

// Escapa um valor JS pra literal de string SQL: dobra aspas simples. dockerPsql
// passa o SQL como UM argv (sem shell), então só o escaping SQL-nível importa.
function _sqlLit(s) {
  return "'" + String(s == null ? "" : s).replace(/'/g, "''") + "'";
}

// Linhas de uma tabela (limit/offset) como JSON, com total. ORDER BY ctid pra
// paginação determinística. Valida o nome e confirma existência.
async function getRows(project, env, table, limit, offset) {
  const dbn = dbName(project, env);
  if (!_ident(table)) return { ok: false, error: "nome de tabela inválido" };
  if (!(await ensureContainer())) return { ok: false, error: "container offline" };
  const ex = await dockerPsql("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='" + table + "';", dbn);
  if (!(ex.ok && ex.out === "1")) return { ok: false, error: "tabela não existe" };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const colsR = await dockerPsql("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='" + table + "' ORDER BY ordinal_position;", dbn);
  const columns = colsR.ok && colsR.out ? colsR.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const totR = await dockerPsql('SELECT count(*) FROM "' + table + '";', dbn);
  const total = totR.ok ? parseInt(totR.out, 10) : null;
  const r = await dockerPsql("SELECT COALESCE(json_agg(t), '[]') FROM (SELECT * FROM \"" + table + "\" ORDER BY ctid LIMIT " + lim + " OFFSET " + off + ") t;", dbn);
  if (!r.ok) return { ok: false, error: r.err || ("code " + r.code) };
  let rows = [];
  try { rows = JSON.parse(r.out || "[]"); } catch { rows = []; }
  return { ok: true, db: dbn, table, columns, rows, limit: lim, offset: off, total };
}

// Colunas de uma tabela (schema public) com tipo, nullable e flag de PK.
// Une information_schema.columns com a PK descoberta via pg_index/pg_attribute.
// Retorna { ok, db, table, columns:[{name,type,nullable,default,pk}], pk:[...] }.
async function getColumns(project, env, table) {
  const dbn = dbName(project, env);
  if (!_ident(table)) return { ok: false, error: "nome de tabela invalido" };
  if (!(await ensureContainer())) return { ok: false, error: "container offline" };
  const ex = await dockerPsql("SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='" + table + "';", dbn);
  if (!(ex.ok && ex.out === "1")) return { ok: false, error: "tabela nao existe" };
  // PK: nomes das colunas que compoem a primary key, na ordem do indice.
  const pkSql =
    "SELECT COALESCE(json_agg(a.attname ORDER BY x.ord), '[]') " +
    "FROM pg_index i " +
    "JOIN pg_class c ON c.oid = i.indrelid " +
    "JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public' " +
    "JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON true " +
    "JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum " +
    "WHERE c.relname = " + _sqlLit(table) + " AND i.indisprimary;";
  const pkR = await dockerPsql(pkSql, dbn);
  let pk = [];
  try { pk = JSON.parse((pkR.ok && pkR.out) || "[]"); } catch { pk = []; }
  const pkSet = new Set(pk);
  // Colunas + tipo + nullable + default.
  const colSql =
    "SELECT COALESCE(json_agg(json_build_object(" +
    "'name', column_name, 'type', data_type, " +
    "'nullable', (is_nullable='YES'), 'default', column_default) ORDER BY ordinal_position), '[]') " +
    "FROM information_schema.columns WHERE table_schema='public' AND table_name=" + _sqlLit(table) + ";";
  const colR = await dockerPsql(colSql, dbn);
  if (!colR.ok) return { ok: false, error: colR.err || ("code " + colR.code) };
  let columns = [];
  try { columns = JSON.parse(colR.out || "[]"); } catch { columns = []; }
  columns = columns.map((c) => ({ ...c, pk: pkSet.has(c.name) }));
  return { ok: true, db: dbn, table, columns, pk };
}

// INSERT de uma linha. Os valores vao como UM literal JSON e o Postgres
// monta o record com json_populate_record(null::"<tabela>", json) — assim
// nao concatenamos valor algum cru; so escapamos as aspas simples do JSON.
// Colunas omitidas no JSON ficam NULL/default. RETURNING devolve a linha criada.
async function insertRow(project, env, table, values) {
  const dbn = dbName(project, env);
  if (!_ident(table)) return { ok: false, error: "nome de tabela invalido" };
  if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, error: "values deve ser objeto" };
  if (!(await ensureContainer())) return { ok: false, error: "container offline" };
  const meta = await getColumns(project, env, table);
  if (!meta.ok) return meta;
  // So passa colunas que existem; chaves desconhecidas sao ignoradas (defesa).
  const allowed = new Set(meta.columns.map((c) => c.name));
  const clean = {};
  for (const k of Object.keys(values)) { if (allowed.has(k)) clean[k] = values[k]; }
  if (!Object.keys(clean).length) return { ok: false, error: "nenhuma coluna valida" };
  const jsonLit = _sqlLit(JSON.stringify(clean));
  // Colunas a inserir: validadas por nome E presentes em information_schema.
  const colList = Object.keys(clean).map((k) => '"' + k + '"').join(", ");
  // CTE + SELECT json_agg: o statement final é um SELECT, então o psql não
  // imprime o command tag ("INSERT 0 1") no stdout junto da linha retornada.
  const sql =
    'WITH ins AS (INSERT INTO "' + table + '" (' + colList + ') ' +
    'SELECT ' + colList + ' FROM json_populate_record(null::"' + table + '", ' + jsonLit + '::json) ' +
    'RETURNING "' + table + '".*) SELECT COALESCE(json_agg(ins), \'[]\') FROM ins;';
  const r = await dockerPsql(sql, dbn);
  if (!r.ok) return { ok: false, error: r.err || ("code " + r.code) };
  let rows = [];
  try { rows = JSON.parse(r.out || "[]"); } catch { rows = []; }
  return { ok: true, db: dbn, table, row: rows[0] || null };
}

// UPDATE de uma linha identificada pela PK. Novos valores via
// json_populate_record (mesmo escaping do insert). A clausula WHERE compara
// cada coluna da PK contra um literal JSON (->> pra texto) — sem concatenar
// valor cru. Exige PK existente e completa no payload pk.
async function updateRow(project, env, table, pk, values) {
  const dbn = dbName(project, env);
  if (!_ident(table)) return { ok: false, error: "nome de tabela invalido" };
  if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, error: "values deve ser objeto" };
  if (!pk || typeof pk !== "object" || Array.isArray(pk)) return { ok: false, error: "pk deve ser objeto" };
  if (!(await ensureContainer())) return { ok: false, error: "container offline" };
  const meta = await getColumns(project, env, table);
  if (!meta.ok) return meta;
  if (!meta.pk.length) return { ok: false, error: "tabela sem primary key — update nao suportado" };
  for (const k of meta.pk) { if (!(k in pk)) return { ok: false, error: "pk incompleta: falta '" + k + "'" }; }
  const allowed = new Set(meta.columns.map((c) => c.name));
  const clean = {};
  for (const k of Object.keys(values)) { if (allowed.has(k) && !meta.pk.includes(k)) clean[k] = values[k]; }
  if (!Object.keys(clean).length) return { ok: false, error: "nenhuma coluna para atualizar" };
  const setCols = Object.keys(clean);
  const valJson = _sqlLit(JSON.stringify(clean));
  const pkJson = _sqlLit(JSON.stringify(pk));
  const setClause = setCols.map((k) => '"' + k + '" = _v."' + k + '"').join(", ");
  // WHERE compara cada coluna da PK como texto (->>) contra a coluna castada
  // pra texto — robusto pra int/uuid/text sem precisar do tipo exato.
  const whereClause = meta.pk.map((k) => '"' + table + '"."' + k + '"::text = (' + pkJson + '::json ->> \'' + k + '\')').join(" AND ");
  // CTE + SELECT json_agg pra evitar o command tag ("UPDATE N") no stdout — sem
  // isso o affected contava o tag como linha (bug com 0 matches).
  const sql =
    'WITH upd AS (UPDATE "' + table + '" SET ' + setClause + ' ' +
    'FROM json_populate_record(null::"' + table + '", ' + valJson + '::json) AS _v ' +
    'WHERE ' + whereClause + ' ' +
    'RETURNING "' + table + '".*) SELECT COALESCE(json_agg(upd), \'[]\') FROM upd;';
  const r = await dockerPsql(sql, dbn);
  if (!r.ok) return { ok: false, error: r.err || ("code " + r.code) };
  let rows = [];
  try { rows = JSON.parse(r.out || "[]"); } catch { rows = []; }
  return { ok: true, db: dbn, table, affected: rows.length, row: rows[0] || null };
}

// DELETE de uma linha identificada pela PK. Mesma estrategia de WHERE por
// literal JSON do updateRow. Retorna { affected }.
async function deleteRow(project, env, table, pk) {
  const dbn = dbName(project, env);
  if (!_ident(table)) return { ok: false, error: "nome de tabela invalido" };
  if (!pk || typeof pk !== "object" || Array.isArray(pk)) return { ok: false, error: "pk deve ser objeto" };
  if (!(await ensureContainer())) return { ok: false, error: "container offline" };
  const meta = await getColumns(project, env, table);
  if (!meta.ok) return meta;
  if (!meta.pk.length) return { ok: false, error: "tabela sem primary key — delete nao suportado" };
  for (const k of meta.pk) { if (!(k in pk)) return { ok: false, error: "pk incompleta: falta '" + k + "'" }; }
  const pkJson = _sqlLit(JSON.stringify(pk));
  const whereClause = meta.pk.map((k) => '"' + table + '"."' + k + '"::text = (' + pkJson + '::json ->> \'' + k + '\')').join(" AND ");
  const sql = 'WITH d AS (DELETE FROM "' + table + '" WHERE ' + whereClause + ' RETURNING 1) SELECT count(*) FROM d;';
  const r = await dockerPsql(sql, dbn);
  if (!r.ok) return { ok: false, error: r.err || ("code " + r.code) };
  return { ok: true, db: dbn, table, affected: parseInt(r.out, 10) || 0 };
}

// SQL editor: roda SQL arbitrario no banco do env. Detecta se o primeiro
// statement e um SELECT/WITH/SHOW/EXPLAIN (retorna {columns,rows}) ou um
// comando de escrita/DDL (retorna {affected, command}). Para SELECT, envolve
// num json_agg pra devolver linhas tipadas; para o resto, roda direto e le o
// command tag do psql. Prod e responsabilidade do front avisar.
async function runSql(project, env, sql) {
  const dbn = dbName(project, env);
  const raw = String(sql == null ? "" : sql).trim();
  if (!raw) return { ok: false, error: "SQL vazio" };
  if (!(await ensureContainer())) return { ok: false, error: "container offline" };
  // Classifica pelo primeiro token relevante (ignora comentarios de linha).
  const stripped = raw.replace(/^(\s*--[^\n]*\n)+/, "").trimStart();
  const head = stripped.slice(0, 12).toLowerCase();
  const isSelect = /^(select|with|show|explain|table|values)\b/.test(head);
  if (isSelect) {
    // Embrulha a query do usuario num subselect e agrega como JSON. Remove
    // ';' final pra poder envelopar. So um statement e suportado no modo read.
    const inner = stripped.replace(/;\s*$/, "");
    const wrapped = "SELECT COALESCE(json_agg(_q), '[]') FROM (" + inner + ") _q;";
    const r = await dockerPsql(wrapped, dbn);
    if (!r.ok) return { ok: false, error: r.err || ("code " + r.code) };
    let rows = [];
    try { rows = JSON.parse(r.out || "[]"); } catch { rows = []; }
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return { ok: true, db: dbn, mode: "select", columns, rows, rowCount: rows.length };
  }
  // Escrita/DDL: roda como veio. dockerPsql usa -tA, entao o command tag
  // (ex.: 'UPDATE 3', 'INSERT 0 1') sai no stdout. Parseia o numero final.
  const r = await dockerPsql(stripped, dbn);
  if (!r.ok) return { ok: false, error: r.err || ("code " + r.code) };
  const lines = (r.out || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const tag = lines[lines.length - 1] || "";
  const m = tag.match(/(\d+)\s*$/);
  const command = (tag.match(/^[A-Z]+/) || [""])[0];
  return { ok: true, db: dbn, mode: "exec", command: command || tag, affected: m ? parseInt(m[1], 10) : null, out: r.out };
}

module.exports = {
  CONTAINER, PG_HOST, PG_PORT, PG_USER,
  sanitize, dbName, connString, dockerPsql, ensureContainer,
  createDb, provision, dropProject, status, listTables, getRows,
  getColumns, insertRow, updateRow, deleteRow, runSql,
};
