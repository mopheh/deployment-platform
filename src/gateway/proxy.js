import http from 'node:http'

// Headers that describe a single connection, not the end-to-end message.
// A proxy must not forward them (RFC 9110 §7.6.1).
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
])

// also drop any header the sender listed in its own Connection header
function cleanHeaders(headers) {
    const extra = new Set(
        String(headers.connection || '')
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
    )
    const out = {}
    for (const [name, value] of Object.entries(headers)) {
        if (!HOP_BY_HOP.has(name) && !extra.has(name)) out[name] = value
    }
    return out
}

function sendError(res, status, message, detail) {
    if (res.headersSent) {

        res.destroy()
        return
    }
    const body = JSON.stringify({ error: message, detail })
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
    })
    res.end(body)
}


function buildForwardHeaders(req) {
    const clientIp = req.socket.remoteAddress
    const headers = cleanHeaders(req.headers)


    headers['x-forwarded-for'] = headers['x-forwarded-for']
        ? `${headers['x-forwarded-for']}, ${clientIp}`
        : clientIp
    headers['x-forwarded-host'] = req.headers.host
    headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http'

    return headers
}

// Forward `req` to 127.0.0.1:<port> and stream the answer back through `res`.
function proxyRequest(req, res, port, { timeoutMs = 30_000 } = {}) {
    const headers = buildForwardHeaders(req)

    const upstream = http.request({
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url, // path + query string, unchanged
        headers,
    })


    upstream.setTimeout(timeoutMs, () => {
        upstream.destroy(Object.assign(new Error('Upstream timed out'), { code: 'ETIMEDOUT' }))
    })

    upstream.on('response', (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, cleanHeaders(upstreamRes.headers))
        upstreamRes.pipe(res)

        upstreamRes.on('error', () => res.destroy())
    })

    upstream.on('error', (err) => {
        console.error(`[proxy] ${req.method} ${req.url} -> :${port} failed: ${err.code || err.message}`)
        if (err.code === 'ETIMEDOUT') return sendError(res, 504, 'Gateway timeout', err.code)
        if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
            return sendError(res, 502, 'Bad gateway', err.code)
        }
        return sendError(res, 502, 'Bad gateway', err.code || err.message)
    })


    res.on('close', () => {
        if (!res.writableFinished) upstream.destroy()
    })

    req.pipe(upstream) // stream the request body to the container (and end() it for bodyless requests)
}


function rejectSocket(socket, status, text) {
    if (socket.destroyed) return
    const body = JSON.stringify({ error: text })
    socket.end(
        `HTTP/1.1 ${status} ${text}\r\n` +
        'content-type: application/json\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n` +
        'connection: close\r\n\r\n' + body
    )
}

// WebSocket (or any Upgrade) support. Called from server.on('upgrade').
// Replays the handshake to 127.0.0.1:<port>, then pipes the two raw sockets together.
function proxyUpgrade(req, socket, head, port, { timeoutMs = 30_000 } = {}) {
    // an upgraded socket has no HTTP error handling of its own; without this a reset crashes the process
    socket.on('error', () => socket.destroy())

    const headers = buildForwardHeaders(req)
    // cleanHeaders strips these as hop-by-hop, but for an upgrade they ARE the point
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade

    const upstream = http.request({
        host: '127.0.0.1',
        port,
        method: req.method,
        path: req.url,
        headers,
    })

    // handshake must complete within timeoutMs; cleared once upgraded (WebSockets idle legitimately)
    upstream.setTimeout(timeoutMs, () => {
        upstream.destroy(Object.assign(new Error('Upstream timed out'), { code: 'ETIMEDOUT' }))
    })

    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        upstream.setTimeout(0)
        upstreamSocket.setTimeout(0)
        socket.setTimeout(0)
        socket.setNoDelay(true)
        upstreamSocket.setNoDelay(true)
        upstreamSocket.on('error', () => socket.destroy())

        // rawHeaders keeps original casing and repeated headers (e.g. Sec-WebSocket-Extensions)
        let raw = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`
        for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
            raw += `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}\r\n`
        }
        socket.write(raw + '\r\n')

        // bytes that arrived in the same packet as the handshake belong to the stream
        if (upstreamHead?.length) socket.write(upstreamHead)
        if (head?.length) upstreamSocket.write(head)

        upstreamSocket.pipe(socket)
        socket.pipe(upstreamSocket)

        // either side closing tears down the other
        socket.on('close', () => upstreamSocket.destroy())
        upstreamSocket.on('close', () => socket.destroy())

        // Server-side sockets are half-open by default: after one side sends FIN, pipe() only half-closes the
        // other. A peer that never answers with its own FIN would leak the tunnel, so force it shut after a grace period.
        const forceClose = () => {
            setTimeout(() => { socket.destroy(); upstreamSocket.destroy() }, 5_000).unref()
        }
        socket.on('end', forceClose)
        upstreamSocket.on('end', forceClose)
    })

    // app answered the handshake with a normal response (e.g. 400/404): relay it and close
    upstream.on('response', (upstreamRes) => {
        if (socket.destroyed) return upstreamRes.resume()
        let raw = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`
        for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
            const name = upstreamRes.rawHeaders[i].toLowerCase()
            if (name === 'connection' || name === 'transfer-encoding') continue
            raw += `${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}\r\n`
        }
        socket.write(raw + 'connection: close\r\n\r\n')
        upstreamRes.pipe(socket) // ends the socket when the body ends
    })

    upstream.on('error', (err) => {
        console.error(`[proxy] UPGRADE ${req.url} -> :${port} failed: ${err.code || err.message}`)
        if (err.code === 'ETIMEDOUT') return rejectSocket(socket, 504, 'Gateway Timeout')
        rejectSocket(socket, 502, 'Bad Gateway')
    })

    // client left before the handshake finished
    socket.on('close', () => upstream.destroy())

    upstream.end()
}

export { proxyRequest, proxyUpgrade, rejectSocket, cleanHeaders }
