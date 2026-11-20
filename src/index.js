import { config } from './config.js'
import { createApp } from './app.js'
import { getDeployment, recoverDeployments } from './db/deployments.js'
import { createUpgradeHandler } from './gateway/routing.js'
import { startWorker } from './worker/worker.js'

recoverDeployments() // interrupted builds go back to the queue; 'running' rows are marked failed
startWorker()

const server = createApp().listen(config.port, () => {
    console.log(`Platform server running on port ${config.port}`)
})

// WebSocket / Upgrade requests never reach Express; Node emits them separately
server.on('upgrade', createUpgradeHandler({ platformHost: config.platformHost, getDeployment }))
