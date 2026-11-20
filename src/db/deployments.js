import { db } from './connection.js'

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
    INSERT INTO deployments (id, repo_url, status, dockerfile_source, dockerfile_content, runtime, env_json, build_env_json, created_at, updated_at)
    VALUES (@id, @repoUrl, @status, @dockerfileSource, @dockerfileContent, @runtime, @envJson, @buildEnvJson, @createdAt, @updatedAt)
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

  // crashed mid-build: put the job back in the queue so a worker retries it
  requeueInterrupted: db.prepare(`
    UPDATE deployments
    SET status = 'queued', updated_at = @now
    WHERE status IN ('cloning', 'cloned', 'building')
  `),

  // TODO: instead check whether the container is still alive
  failRunning: db.prepare(`
    UPDATE deployments
    SET status = 'failed', updated_at = @now
    WHERE status = 'running'
  `),

  claimNextJob: db.prepare(`
    UPDATE deployments
    SET status = 'cloning', updated_at = @now
    WHERE id = (SELECT id from deployments WHERE status = 'queued' 
    ORDER BY created_at ASC LIMIT 1)
    RETURNING *
    `)
}

// env and buildEnv must already be validated { KEY: "value" } objects (see lib/env.js)
function createDeployment(id, repoUrl, { dockerfileContent = null, env = {}, buildEnv = {} } = {}) {
  const now = Date.now()
  statements.insertDeployment.run({
    id,
    repoUrl,
    status: 'queued',
    dockerfileContent,
    dockerfileSource: null,
    runtime: null,
    envJson: JSON.stringify(env ?? {}),
    buildEnvJson: JSON.stringify(buildEnv ?? {}),
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
function recoverDeployments() {
  const now = Date.now()
  statements.requeueInterrupted.run({ now })
  statements.failRunning.run({ now })
}
function setContainerInfo(id, hostPort, containerName) {
  statements.updateContainerInfo.run({ id, hostPort, containerName, updatedAt: Date.now() })
}

function claimNextJob() {
  return statements.claimNextJob.get({ now: Date.now() })
}



export { createDeployment, updateStatus, appendLog, getDeployment, getLogs, setDockerfileInfo, recoverDeployments, setContainerInfo, claimNextJob }
