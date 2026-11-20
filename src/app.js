import express from 'express'
import { config } from './config.js'
import { getDeployment } from './db/deployments.js'
import { createHostRouter } from './gateway/routing.js'
import healthRoutes from './routes/health.js'
import deploymentRoutes from './routes/deployments.js'

export function createApp() {
    const app = express()

    // must come first: routes <id>.<platformHost> to deployments before any body parsing or API routes
    app.use(createHostRouter({ platformHost: config.platformHost, getDeployment }))

    app.use(express.json())
    app.use(healthRoutes)
    app.use(deploymentRoutes)

    return app
}
