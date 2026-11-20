import { proxyRequest, proxyUpgrade, rejectSocket } from './proxy.js'

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/ // a single valid DNS label

// "Localhost:3000" -> "localhost", "[::1]:3000" -> "::1", undefined -> ''
function stripPort(host) {
    if (typeof host !== 'string') return ''
    host = host.trim().toLowerCase()
    if (host.startsWith('[')) {
        const end = host.indexOf(']')
        return end === -1 ? '' : host.slice(1, end)
    }
    const colon = host.lastIndexOf(':')
    if (colon !== -1) host = host.slice(0, colon)
    return host.replace(/\.$/, '') // a trailing dot is a valid FQDN form
}

// pure function: no Express, no DB
function parseHost(hostHeader, platformHost) {
    const host = stripPort(hostHeader)
    const base = platformHost.toLowerCase()

    if (!host) return { type: 'unknown' }
    if (host === base) return { type: 'platform' }


    const suffix = `.${base}`
    if (host.endsWith(suffix)) {
        const id = host.slice(0, -suffix.length)

        if (LABEL.test(id)) return { type: 'app', id }
    }
    return { type: 'unknown' }
}

// getDeployment and proxy are injected so the middleware can be tested without a database or sockets
function createHostRouter({ platformHost = 'localhost', getDeployment, proxy = proxyRequest }) {
    return function hostRouter(req, res, next) {
        const target = parseHost(req.headers.host, platformHost)

        if (target.type === 'platform') return next()

        if (target.type === 'unknown') {
            return res.status(404).json({ error: 'Unknown host' })
        }

        const deployment = getDeployment(target.id)
        if (!deployment) {
            return res.status(404).json({ error: 'Deployment not found' })
        }
        if (deployment.status !== 'running' || !deployment.host_port) {
            return res.status(503).json({
                error: 'Deployment is not running',
                status: deployment.status,
            })
        }

        return proxy(req, res, deployment.host_port)
    }
}

// same routing rules as createHostRouter, but for server.on('upgrade') where there is no Express and no `res`
function createUpgradeHandler({ platformHost = 'localhost', getDeployment, upgrade = proxyUpgrade }) {
    return function onUpgrade(req, socket, head) {
        const target = parseHost(req.headers.host, platformHost)

        // the platform's own API has no WebSocket endpoints
        if (target.type !== 'app') return rejectSocket(socket, 404, 'Not Found')

        const deployment = getDeployment(target.id)
        if (!deployment) return rejectSocket(socket, 404, 'Not Found')
        if (deployment.status !== 'running' || !deployment.host_port) {
            return rejectSocket(socket, 503, 'Service Unavailable')
        }

        return upgrade(req, socket, head, deployment.host_port)
    }
}

export { parseHost, stripPort, createHostRouter, createUpgradeHandler }
