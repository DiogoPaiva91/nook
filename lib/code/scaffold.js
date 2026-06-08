const fs = require("fs");
const path = require("path");

// Stack de banco dos projetos do Código mode = Supabase NATIVE.
// Cada projeto é um projeto Supabase próprio: o `supabase/` (config + migrations)
// e o `supabase start`/keys são tratados no provisionamento (lib/code/db.js via
// CLI `supabase`). Aqui só escrevemos os arquivos da APP — idempotente, sem rede
// nem docker. Acesso = @supabase/supabase-js; schema/migrations = CLI do Supabase
// (fonte oficial em supabase/migrations). Sem Drizzle.
const DEPS = { "@supabase/supabase-js": "^2.45.0" };
const SCRIPTS = {
  "supabase:start": "supabase start",
  "supabase:stop": "supabase stop",
  "db:reset": "supabase db reset",
  "migration:new": "supabase migration new",
  "db:diff": "supabase db diff -f",
  "gen:types": "supabase gen types typescript --local > lib/database.types.ts",
  "db:push": "supabase db push",
};

const SUPABASE_CLIENT = `import { createClient } from "@supabase/supabase-js";

// URL e chaves vêm do ambiente. DEV: o Nook preenche o .env ao subir o Supabase
// local do projeto. PROD: do projeto Supabase linkado (.env.production).
// Front-end (Vite/Next): exponha com o prefixo do framework (VITE_/NEXT_PUBLIC_) e
// troque process.env pela env pública correspondente.
const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) {
  throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY ausentes — provisione o banco pelo Nook");
}

export const supabase = createClient(url, anonKey);
`;

const ENV_EXAMPLE = `# Preenchido automaticamente ao provisionar pelo Nook (sobe o Supabase local do projeto).
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# Expostas ao front (Realtime/cliente no browser). Vite lê VITE_*, Next lê NEXT_PUBLIC_*.
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=
# Conexão direta ao Postgres (migrations/admin) — porta 54322 no Supabase local.
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
`;

// MCP do Supabase pro agente (Claude Code lê .mcp.json no projeto). Dev = MCP local
// do stack (Kong :54321/mcp). Ao conectar prod, o Hub acrescenta um server
// "supabase-prod" apontando pro Cloud (mcp.supabase.com).
const MCP_JSON = JSON.stringify({
  mcpServers: {
    supabase: { type: "http", url: "http://127.0.0.1:54321/mcp" },
  },
}, null, 2) + "\n";

function patchJson(filePath, mutate) {
  let json = {};
  try { json = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch {}
  mutate(json);
  fs.writeFileSync(filePath, JSON.stringify(json, null, 2) + "\n");
}

function ensureGitignore(projectPath) {
  const gi = path.join(projectPath, ".gitignore");
  let cur = "";
  try { cur = fs.readFileSync(gi, "utf8"); } catch {}
  const needed = [".env", ".env.production", ".env.local", "supabase/.branches", "supabase/.temp"];
  const missing = needed.filter((l) => !cur.split("\n").some((x) => x.trim() === l));
  if (missing.length) {
    fs.writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "\n# nook supabase (keys locais + estado da CLI)\n" + missing.join("\n") + "\n");
  }
}

// Escreve os arquivos da app (cliente supabase-js, .env.example, gitignore, deps+
// scripts). Não toca em supabase/ (criado no provision via `supabase init`) nem em
// arquivos do usuário já existentes (lib/supabase.ts não é sobrescrito).
function scaffoldSupabase(projectPath, projectName) {
  const written = [];
  const w = (rel, content, { force = true } = {}) => {
    const full = path.join(projectPath, rel);
    if (!force && fs.existsSync(full)) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    written.push(rel);
  };
  w("lib/supabase.ts", SUPABASE_CLIENT, { force: false });
  w(".env.example", ENV_EXAMPLE);
  w(".mcp.json", MCP_JSON, { force: false });

  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    patchJson(pkgPath, (pkg) => {
      pkg.dependencies = Object.assign({}, pkg.dependencies, DEPS);
      pkg.scripts = Object.assign({}, pkg.scripts, SCRIPTS);
    });
    written.push("package.json (deps+scripts)");
  }

  ensureGitignore(projectPath);
  written.push(".env.example");
  return { written };
}

// Escreve o .env (dev) e .env.production a partir das keys do Supabase. As keys do
// ambiente local saem de `supabase status` (lib/code/db.js); as de prod, do projeto
// linkado. Chamado pelo provision DEPOIS de subir o stack.
function writeEnvFiles(projectPath, env, keys) {
  const target = env === "prod" ? ".env.production" : ".env";
  const lines = [
    "SUPABASE_URL=" + (keys.url || ""),
    "SUPABASE_ANON_KEY=" + (keys.anonKey || ""),
    "SUPABASE_SERVICE_ROLE_KEY=" + (keys.serviceRoleKey || ""),
    // Expostas ao front (Realtime/cliente no browser): Vite lê VITE_*, Next lê NEXT_PUBLIC_*.
    "VITE_SUPABASE_URL=" + (keys.url || ""),
    "VITE_SUPABASE_ANON_KEY=" + (keys.anonKey || ""),
    "NEXT_PUBLIC_SUPABASE_URL=" + (keys.url || ""),
    "NEXT_PUBLIC_SUPABASE_ANON_KEY=" + (keys.anonKey || ""),
  ];
  if (keys.dbUrl) lines.push("DATABASE_URL=" + keys.dbUrl);
  lines.push("NODE_ENV=" + (env === "prod" ? "production" : "development"));
  fs.writeFileSync(path.join(projectPath, target), lines.join("\n") + "\n");
  return target;
}

// ── Secrets (gerenciador visual do .env / .env.production) ──
// Chaves auto-geradas pelo provisionamento — editáveis, mas marcadas (re-provisionar
// sobrescreve). As secrets do usuário são livres.
const MANAGED_KEYS = new Set([
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "DATABASE_URL", "NODE_ENV",
]);
function _envFile(env) { return env === "prod" ? ".env.production" : ".env"; }
function _validKey(k) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(k || "")); }

function readSecrets(projectPath, env) {
  const file = _envFile(env);
  let txt;
  try { txt = fs.readFileSync(path.join(projectPath, file), "utf8"); }
  catch { return { ok: true, env: env === "prod" ? "prod" : "dev", file, exists: false, secrets: [] }; }
  const secrets = [];
  txt.split("\n").forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) secrets.push({ key: m[1], value: m[2].replace(/^["']|["']$/g, ""), managed: MANAGED_KEYS.has(m[1]) });
  });
  return { ok: true, env: env === "prod" ? "prod" : "dev", file, exists: true, secrets };
}

function setSecret(projectPath, env, key, value) {
  if (!_validKey(key)) return { ok: false, error: "nome inválido — use A-Z, 0-9, _ e comece com letra ou _" };
  const p = path.join(projectPath, _envFile(env));
  let lines;
  try { lines = fs.readFileSync(p, "utf8").split("\n"); } catch { lines = []; }
  const newLine = key + "=" + String(value == null ? "" : value);
  let found = false;
  lines = lines.map((l) => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1] === key) { found = true; return newLine; }
    return l;
  });
  if (!found) lines.push(newLine);
  try { fs.writeFileSync(p, lines.join("\n").replace(/\n*$/, "") + "\n"); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

function deleteSecret(projectPath, env, key) {
  const p = path.join(projectPath, _envFile(env));
  let lines;
  try { lines = fs.readFileSync(p, "utf8").split("\n"); } catch { return { ok: true }; }
  lines = lines.filter((l) => {
    const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !(m && m[1] === key);
  });
  try { fs.writeFileSync(p, lines.join("\n").replace(/\n*$/, "") + "\n"); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

module.exports = { scaffoldSupabase, writeEnvFiles, readSecrets, setSecret, deleteSecret };
