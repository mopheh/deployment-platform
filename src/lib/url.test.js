import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPublicUrl } from './url.js'

test('local dev: includes the platform port', () => {
    assert.equal(buildPublicUrl('d1', { platformHost: 'localhost', port: 3000 }), 'http://d1.localhost:3000')
})

test('omits default ports for the scheme', () => {
    assert.equal(buildPublicUrl('d1', { platformHost: 'example.com', scheme: 'https', port: 443 }), 'https://d1.example.com')
    assert.equal(buildPublicUrl('d1', { platformHost: 'example.com', port: 80 }), 'http://d1.example.com')
})

test('no port given -> no port in URL', () => {
    assert.equal(buildPublicUrl('d1', { platformHost: 'example.com', scheme: 'https' }), 'https://d1.example.com')
})
