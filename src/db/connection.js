import Database from 'better-sqlite3'
import { config } from '../config.js'

export const db = new Database(config.dbPath)

db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    repo_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    dockerfile_source TEXT,
    runtime TEXT,
    host_port INTEGER,
    container_name TEXT,
    dockerfile_content TEXT,
    env_json TEXT,
    build_env_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deployment_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment_id TEXT NOT NULL,
    line TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (deployment_id) REFERENCES deployments(id)
  );
`)

// CREATE TABLE IF NOT EXISTS won't add columns to a table that already exists,
// so databases created by an older version get any missing columns here.
function addColumnIfMissing(table, column, type) {
  const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

addColumnIfMissing('deployments', 'dockerfile_content', 'TEXT')
addColumnIfMissing('deployments', 'env_json', 'TEXT') // runtime env vars (docker run -e), JSON object
addColumnIfMissing('deployments', 'build_env_json', 'TEXT') // build-time args (docker build --build-arg), JSON object
