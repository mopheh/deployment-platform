import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHost, createHostRouter } from './routing.js'

const P = 'localhost'

test('platform host, with and without port, any case', () => {
    assert.deepEqual(parseHost('localhost', P), { type: 'platform' })
    assert.deepEqual(parseHost('localhost:3000', P), { type: 'platform' })
    assert.deepEqual(parseHost('LocalHost:3000', P), { type: 'platform' })
    assert.deepEqual(parseHost('localhost.:3000', P), { type: 'platform' })
})

test('app subdomain', () => {
    assert.deepEqual(parseHost('deploy-1-abc.localhost:3000', P), { type: 'app', id: 'deploy-1-abc' })
    assert.deepEqual(parseHost('DEPLOY-1-ABC.localhost', P), { type: 'app', id: 'deploy-1-abc' })
})

test('unknown hosts', () => {
    for (const h of [undefined, '', 'evil.com', 'notlocalhost', 'localhost.evil.com',
        'deploy-1.localhost.evil.com', 'a.b.localhost', '-bad.localhost', '.localhost',
        '[::1]:3000', '[broken']) {
        assert.deepEqual(parseHost(h, P), { type: 'unknown' }, String(h))
    }
})

test('custom platform host', () => {
    assert.deepEqual(parseHost('abc.example.com', 'example.com'), { type: 'app', id: 'abc' })
    assert.deepEqual(parseHost('localhost', 'example.com'), { type: 'unknown' })
})

// minimal fake req/res to exercise the middleware without Express or a DB
function run(host, deployment) {
    const out = { nextCalled: false }
    const proxy = (req, res, port) => { out.proxied = { port } }
    const router = createHostRouter({ platformHost: P, getDeployment: () => deployment, proxy })
    const res = {
        status(code) { out.status = code; return this },
        json(body) { out.body = body; return this },
    }
    router({ headers: { host } }, res, () => { out.nextCalled = true })
    return out
}

test('middleware: platform host falls through to next()', () => {
    assert.equal(run('localhost:3000', null).nextCalled, true)
})

test('middleware: unknown host -> 404', () => {
    const r = run('evil.com', null)
    assert.equal(r.status, 404)
    assert.equal(r.nextCalled, false)
})

test('middleware: unknown deployment -> 404', () => {
    assert.equal(run('abc.localhost', null).status, 404)
})

test('middleware: not running -> 503 with status', () => {
    const r = run('abc.localhost', { status: 'building', host_port: null })
    assert.equal(r.status, 503)
    assert.equal(r.body.status, 'building')
})

test('middleware: running but no port -> 503', () => {
    assert.equal(run('abc.localhost', { status: 'running', host_port: null }).status, 503)
})

test('middleware: running -> proxied to the stored port', () => {
    const r = run('abc.localhost', { status: 'running', host_port: 49153 })
    assert.deepEqual(r.proxied, { port: 49153 })
    assert.equal(r.status, undefined)
    assert.equal(r.nextCalled, false)
})
