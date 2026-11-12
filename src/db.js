import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const db = new Database(path.join(__dirname, '..', 'platform.db'))
// update the CREATE TABLE statement
db.exec(`
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    repo_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    dockerfile_source TEXT,
    runtime TEXT,
    host_port INTEGER,
    container_name TEXT,
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





// add a new function to update dockerfile info after detection
const updateDockerfileInfo = db.prepare(`
  UPDATE deployments
  SET dockerfile_source = @source, runtime = @runtime, updated_at = @updatedAt
  WHERE id = @id
`)

function setDockerfileInfo(id, source, runtime = null) {
  updateDockerfileInfo.run({ id, source, runtime, updatedAt: Date.now() })
}


// prepared statements — write these once, call many times
// SQLite compiles the query plan once; much faster than raw strings each time
const statements = {
  insertDeployment: db.prepare(`
    INSERT INTO deployments (id, repo_url, status, dockerfile_source, runtime, created_at, updated_at)
    VALUES (@id, @repoUrl, @status, @dockerfileSource, @runtime, @createdAt, @updatedAt)
    `),

  updateStatus: db.prepare(`
      UPDATE deployments 
      SET status = @status, updated_at = @updatedAt
      WHERE id = @id
      `),

  insertLog: db.prepare(`
        INSERT INTO deployment_logs (deployment_id, line, created_at)
        VALUES (@deploymentId, @line, @createdAt)
        `),

  getDeployment: db.prepare(`
          SELECT * FROM deployments WHERE id = ?
          `),

  getLogs: db.prepare(`
            SELECT line FROM deployment_logs 
            WHERE deployment_id = ?
            ORDER BY id ASC
            `),

  updateContainerInfo: db.prepare(`
    UPDATE deployments
    SET host_port = @hostPort, container_name = @containerName, updated_at = @updatedAt
    WHERE id = @id
  `),

  failStaleDeployments: db.prepare(`
    UPDATE deployments
    SET status = 'failed'
    WHERE status NOT IN ('complete', 'failed') 
  `)
}

// update createDeployment function
function createDeployment(id, repoUrl) {
  const now = Date.now()
  statements.insertDeployment.run({
    id,
    repoUrl,
    status: 'cloning',
    dockerfileSource: null,
    runtime: null,
    createdAt: now,
    updatedAt: now
  })
}

function updateStatus(id, status) {
  statements.updateStatus.run({ id, status, updatedAt: Date.now() })
}

function appendLog(deploymentId, line) {
  statements.insertLog.run({ deploymentId, line, createdAt: Date.now() })
}

function getDeployment(id) {
  return statements.getDeployment.get(id)
}

function getLogs(deploymentId) {
  return statements.getLogs.all(deploymentId).map(r => r.line)
}
function failStaleDeployments() {
  statements.failStaleDeployments.run()
}
function setContainerInfo(id, hostPort, containerName) {
  statements.updateContainerInfo.run({ id, hostPort, containerName, updatedAt: Date.now() })
}

export { createDeployment, updateStatus, appendLog, getDeployment, getLogs, setDockerfileInfo, failStaleDeployments, setContainerInfo }
