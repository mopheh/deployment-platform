import { config } from '../config.js'

// Builds the public URL for a deployment: <scheme>://<id>.<platformHost>[:port]
// The port is omitted when it is the default for the scheme (e.g. behind Caddy/nginx on 80/443).
function buildPublicUrl(id, { platformHost = 'localhost', scheme = 'http', port } = {}) {
    const defaultPort = scheme === 'https' ? 443 : 80
    const p = port === undefined || port === '' ? null : Number(port)
    const showPort = p !== null && Number.isInteger(p) && p !== defaultPort
    return `${scheme}://${id}.${platformHost}${showPort ? `:${p}` : ''}`
}

// same thing using the platform's own configuration
const publicUrl = (id) =>
    buildPublicUrl(id, { platformHost: config.platformHost, scheme: config.publicScheme, port: config.publicPort })

export { buildPublicUrl, publicUrl }
