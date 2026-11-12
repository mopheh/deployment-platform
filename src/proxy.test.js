import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { proxyRequest, proxyUpgrade, cleanHeaders } from './proxy.js'
import { createUpgradeHandler } from './routing.js'

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
const close = (server) => new Promise((r) => { server.closeAllConnections?.(); server.close(r) })

// talks to a proxy server and returns { status, headers, body }
function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

// an "app" that echoes back what it received
const app = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
        if (req.url === '/redirect') { res.writeHead(302, { location: '/elsewhere', 'set-cookie': ['a=1', 'b=2'] }); return res.end() }
        if (req.url === '/missing') { res.writeHead(404); return res.end('nope') }
        if (req.url === '/slow') return // never answers
        if (req.url === '/big') { res.writeHead(200); return res.end('x'.repeat(5_000_000)) }
        res.writeHead(200, { 'content-type': 'application/json', 'x-from-app': 'yes' })
        res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }))
    })
})

let appPort, gw, gwPort
test.before(async () => {
    appPort = await listen(app)
    gw = http.createServer((req, res) => proxyRequest(req, res, appPort, { timeoutMs: 300 }))
    gwPort = await listen(gw)
})
test.after(async () => { await close(gw); await close(app) })

test('GET keeps path and query string, passes response headers', async () => {
    const r = await request(gwPort, { path: '/a/b?x=1&y=%20z' })
    const got = JSON.parse(r.body)
    assert.equal(r.status, 200)
    assert.equal(got.url, '/a/b?x=1&y=%20z')
    assert.equal(r.headers['x-from-app'], 'yes')
})

test('POST body reaches the app', async () => {
    const r = await request(gwPort, { method: 'POST', path: '/p', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
    assert.equal(JSON.parse(r.body).body, '{"a":1}')
})

test('status codes, redirects and multiple cookies pass through untouched', async () => {
    assert.equal((await request(gwPort, { path: '/missing' })).status, 404)
    const r = await request(gwPort, { path: '/redirect' })
    assert.equal(r.status, 302)
    assert.equal(r.headers.location, '/elsewhere')
    assert.deepEqual(r.headers['set-cookie'], ['a=1', 'b=2'])
})

test('Host is preserved and X-Forwarded-* are added', async () => {
    const r = await request(gwPort, { headers: { host: 'abc.localhost:3000', 'x-forwarded-for': '9.9.9.9' } })
    const h = JSON.parse(r.body).headers
    assert.equal(h.host, 'abc.localhost:3000')
    assert.equal(h['x-forwarded-for'], '9.9.9.9, 127.0.0.1')
    assert.equal(h['x-forwarded-host'], 'abc.localhost:3000')
    assert.equal(h['x-forwarded-proto'], 'http')
})

test('hop-by-hop headers are not forwarded', async () => {
    const r = await request(gwPort, { headers: { 'proxy-authorization': 'x', 'x-secret-hop': 'y', connection: 'x-secret-hop' } })
    const h = JSON.parse(r.body).headers
    assert.equal(h['proxy-authorization'], undefined)
    assert.equal(h['x-secret-hop'], undefined)
})

test('large response is delivered intact', async () => {
    const r = await request(gwPort, { path: '/big' })
    assert.equal(r.body.length, 5_000_000)
})

test('app down -> 502, and the proxy survives', async () => {
    const dead = http.createServer((req, res) => proxyRequest(req, res, 1)) // nothing listens on port 1
    const port = await listen(dead)
    const r = await request(port)
    assert.equal(r.status, 502)
    assert.equal(JSON.parse(r.body).detail, 'ECONNREFUSED')
    assert.equal((await request(port)).status, 502)
    await close(dead)
})

test('app never answers -> 504', async () => {
    const r = await request(gwPort, { path: '/slow' })
    assert.equal(r.status, 504)
})

// ---- upgrade / WebSocket-style tunnelling ----

// app side: accepts `Upgrade: echo`, replies 101, then echoes every byte back uppercased
app.on('upgrade', (req, socket) => {
    if (req.url === '/refuse') {
        socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n')
        return
    }
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n' +
        `X-Saw-Forwarded-For: ${req.headers['x-forwarded-for']}\r\n\r\n`
    )
    socket.on('data', (d) => socket.write(d.toString().toUpperCase()))
    socket.on('end', () => socket.end()) // a well-behaved peer answers FIN with FIN
})

function upgradeClient(port, path = '/') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'echo' } })
        req.on('upgrade', (res, socket) => resolve({ res, socket }))
        req.on('response', (res) => { res.resume(); resolve({ res, socket: null }) })
        req.on('error', reject)
        req.end()
    })
}

test('upgrade: handshake completes and bytes flow both ways', async () => {
    const up = http.createServer()
    up.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, appPort))
    const port = await listen(up)

    const { res, socket } = await upgradeClient(port)
    assert.equal(res.statusCode, 101)
    assert.equal(res.headers.upgrade, 'echo')
    assert.equal(res.headers['x-saw-forwarded-for'], '127.0.0.1')

    const reply = await new Promise((resolve) => {
        socket.once('data', (d) => resolve(d.toString()))
        socket.write('hello')
    })
    assert.equal(reply, 'HELLO')

    socket.destroy()
    await close(up)
})

test('upgrade: app refusing the handshake is relayed to the client', async () => {
    const up = http.createServer()
    up.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, appPort))
    const port = await listen(up)

    const { res, socket } = await upgradeClient(port, '/refuse')
    assert.equal(res.statusCode, 400)
    assert.equal(socket, null)
    await close(up)
})

test('upgrade: app down -> 502', async () => {
    const up = http.createServer()
    up.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, 1))
    const port = await listen(up)

    const { res } = await upgradeClient(port)
    assert.equal(res.statusCode, 502)
    await close(up)
})

test('upgrade: closing the client closes the app side', async () => {
    let appSocket
    const closed = new Promise((resolve) => {
        const raw = http.createServer()
        raw.on('upgrade', (req, socket) => {
            appSocket = socket
            socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n')
            socket.on('end', () => socket.end())
            socket.on('close', resolve)
        })
        listen(raw).then(async (rawPort) => {
            const up = http.createServer()
            up.on('upgrade', (req, socket, head) => proxyUpgrade(req, socket, head, rawPort))
            const port = await listen(up)
            const { socket } = await upgradeClient(port)
            socket.destroy()
            closed.then(async () => { await close(up); await close(raw) })
        })
    })
    await closed
    assert.ok(appSocket.destroyed)
})

test('createUpgradeHandler routes by Host and rejects unknown/not-running', async () => {
    const calls = []
    const handler = createUpgradeHandler({
        platformHost: 'localhost',
        getDeployment: (id) => ({ ok: { status: 'running', host_port: 4567 }, stopped: { status: 'failed', host_port: null } }[id]),
        upgrade: (req, socket, head, port) => calls.push(port),
    })
    const fakeSocket = () => { const s = { out: '', destroyed: false, end(x) { this.out = x } }; return s }
    const run = (host) => { const s = fakeSocket(); handler({ headers: { host } }, s, Buffer.alloc(0)); return s }

    run('ok.localhost:3000')
    assert.deepEqual(calls, [4567])
    assert.match(run('stopped.localhost').out, /^HTTP\/1\.1 503/)
    assert.match(run('nope.localhost').out, /^HTTP\/1\.1 404/)
    assert.match(run('localhost:3000').out, /^HTTP\/1\.1 404/)
    assert.equal(calls.length, 1)
})

test('cleanHeaders drops hop-by-hop and Connection-listed headers', () => {
    assert.deepEqual(
        cleanHeaders({ connection: 'close, x-a', 'x-a': '1', 'keep-alive': 't', te: 'x', accept: '*/*' }),
        { accept: '*/*' }
    )
})
