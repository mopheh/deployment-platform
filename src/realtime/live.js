// Live (in-memory) state for deployments being watched over SSE.
// Logs and statuses themselves are persisted in SQLite; this only tracks connected clients.

export const TERMINAL = new Set(['running', 'complete', 'failed'])

export const deployments = {}

// create the entry on demand, e.g. a client connects while the job is still queued, or after a restart
export function getLive(id) {
    return (deployments[id] ??= { status: 'queued', logs: [], clients: [] })
}

export function sseSend(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
}
