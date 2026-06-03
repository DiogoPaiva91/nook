const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const db = require("./db");

// Versões pinadas (offline-friendly, sem surpresa de major).
const DEPS = { "drizzle-orm": "^0.36.4", "pg": "^8.13.1" };
const DEV_DEPS = { "drizzle-kit": "^0.28.1", "@types/pg": "^8.11.10", "dotenv": "^16.4.7", "tsx": "^4.19.2" };
const SCRIPTS = {
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate",
  "db:push": "drizzle-kit push",
  "db:studio": "drizzle-kit studio",
};

const DRIZZLE_CONFIG = `import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
`;

const DB_INDEX = `import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// DATABASE_URL é injetado por ambiente: o dev server do Jarvis aponta pro banco
// <proj>_dev; build/produção usa <proj>_prod. Nunca hardcode a connection string.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });
`;

const DB_SCHEMA = `import { pgTable, uuid, text, timestamp } from "drizzle-orm/pg-core";

// Exemplo — edite à vontade. Depois: \`npm run db:generate\` cria a migration e
// \`npm run db:migrate\` aplica no banco de DEV. Promova pra PROD pelo Jarvis.
export const exemplo = pgTable("exemplo", {
  id: uuid("id").primaryKey().defaultRandom(),
  nome: text("nome").notNull(),
  criadoEm: timestamp("criado_em").defaultNow().notNull(),
});
`;

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
  const needed = [".env", ".env.development", ".env.production", ".env.local"];
  const missing = needed.filter((l) => !cur.split("\n").some((x) => x.trim() === l));
  if (missing.length) {
    fs.writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "\n# jarvis postgres (local creds)\n" + missing.join("\n") + "\n");
  }
}

function writeEnvFiles(projectPath, projectName) {
  const devUrl = db.connString(projectName, "dev");
  const prodUrl = db.connString(projectName, "prod");
  fs.writeFileSync(path.join(projectPath, ".env.development"), "DATABASE_URL=" + devUrl + "\nNODE_ENV=development\n");
  fs.writeFileSync(path.join(projectPath, ".env.production"), "DATABASE_URL=" + prodUrl + "\nNODE_ENV=production\n");
  // .env ativo = dev (default local). É o que dotenv carrega por padrão.
  fs.writeFileSync(path.join(projectPath, ".env"), "DATABASE_URL=" + devUrl + "\nNODE_ENV=development\n");
  fs.writeFileSync(path.join(projectPath, ".env.example"),
    "DATABASE_URL=postgresql://postgres:senha@localhost:5432/" + db.dbName(projectName, "dev") + "\nNODE_ENV=development\n");
  return { devUrl, prodUrl };
}

// Escreve o scaffold Drizzle no projeto (idempotente: não sobrescreve schema.ts
// se já existir, pra não apagar o trabalho do usuário).
function scaffoldDrizzle(projectPath, projectName) {
  const written = [];
  const w = (rel, content, { force = true } = {}) => {
    const full = path.join(projectPath, rel);
    if (!force && fs.existsSync(full)) return;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    written.push(rel);
  };
  w("drizzle.config.ts", DRIZZLE_CONFIG);
  w("db/index.ts", DB_INDEX);
  w("db/schema.ts", DB_SCHEMA, { force: false });
  fs.mkdirSync(path.join(projectPath, "db", "migrations"), { recursive: true });

  const pkgPath = path.join(projectPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    patchJson(pkgPath, (pkg) => {
      pkg.dependencies = Object.assign({}, pkg.dependencies, DEPS);
      pkg.devDependencies = Object.assign({}, pkg.devDependencies, DEV_DEPS);
      pkg.scripts = Object.assign({}, pkg.scripts, SCRIPTS);
    });
    written.push("package.json (deps+scripts)");
  }

  const env = writeEnvFiles(projectPath, projectName);
  written.push(".env.development", ".env.production", ".env", ".env.example");
  ensureGitignore(projectPath);
  return { written, env };
}

// Roda um subcomando do drizzle-kit no contexto do projeto, com DATABASE_URL do
// ambiente alvo. `npx` resolve o drizzle-kit local (precisa de npm install antes).
function runDrizzle(projectPath, projectName, env, subcommand) {
  return new Promise((resolve) => {
    const databaseUrl = db.connString(projectName, env === "prod" ? "prod" : "dev");
    const proc = spawn("npx", ["drizzle-kit", subcommand], {
      cwd: projectPath,
      env: Object.assign({}, process.env, { DATABASE_URL: databaseUrl, NODE_ENV: env === "prod" ? "production" : "development" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    proc.stdout.on("data", (d) => (log += d));
    proc.stderr.on("data", (d) => (log += d));
    proc.on("close", (code) => resolve({ ok: code === 0, code, env, databaseUrl, log: log.slice(-8000) }));
    proc.on("error", (e) => resolve({ ok: false, code: -1, env, log: e.message }));
  });
}

module.exports = { scaffoldDrizzle, writeEnvFiles, runDrizzle, ensureGitignore };
