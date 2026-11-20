import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

// every environment variable the platform reads lives here
export const config = {
    port: Number(process.env.PORT) || 3000,

    // deployments are served at <id>.<platformHost>
    platformHost: process.env.PLATFORM_HOST || 'localhost',

    // how users reach a deployment. Behind a TLS proxy: PUBLIC_SCHEME=https PUBLIC_PORT=443
    publicScheme: process.env.PUBLIC_SCHEME || 'http',
    publicPort: process.env.PUBLIC_PORT ?? '3000',
    dbPath: process.env.DB_PATH || path.join(root, 'platform.db'),
    buildsDir: process.env.BUILDS_DIR || '/tmp/builds',
    maxWorkers: Number(process.env.MAX_WORKERS) || 2,
}
