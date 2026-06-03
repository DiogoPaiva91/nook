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

module.exports = {
  CONTAINER, PG_HOST, PG_PORT, PG_USER,
  sanitize, dbName, connString, dockerPsql, ensureContainer,
  createDb, provision, dropProject, status,
};
