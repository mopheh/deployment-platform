import test from 'node:test'
import assert from 'node:assert/strict'
import { parseEnvVars, MAX_KEYS, MAX_VALUE_LENGTH } from './env.js'

test('nothing in -> empty object', () => {
    assert.deepEqual(parseEnvVars(undefined), {})
    assert.deepEqual(parseEnvVars(null), {})
    assert.deepEqual(parseEnvVars(''), {})
})

test('parses KEY=value lines', () => {
    assert.deepEqual(parseEnvVars('A=1\nB=two'), { A: '1', B: 'two' })
})

test('skips blank lines and comments', () => {
    assert.deepEqual(parseEnvVars('# a comment\n\nA=1\n   \n  # indented comment\nB=2'), { A: '1', B: '2' })
})

test('only the first "=" splits, so values can contain "="', () => {
    assert.deepEqual(parseEnvVars('URL=postgres://u:p@h/db?sslmode=require'), { URL: 'postgres://u:p@h/db?sslmode=require' })
})

test('handles Windows line endings', () => {
    assert.deepEqual(parseEnvVars('A=1\r\nB=2\r\n'), { A: '1', B: '2' })
})

test('strips one matching pair of quotes, keeps the rest', () => {
    assert.deepEqual(parseEnvVars('A="hello world"\nB=\'x\'\nC="unbalanced\nD=it\'s'), {
        A: 'hello world', B: 'x', C: '"unbalanced', D: "it's",
    })
})

test('does not strip inline # (a value may contain it)', () => {
    assert.deepEqual(parseEnvVars('COLOR=#ff0000'), { COLOR: '#ff0000' })
})

test('accepts an "export " prefix', () => {
    assert.deepEqual(parseEnvVars('export A=1'), { A: '1' })
})

test('empty value is allowed', () => {
    assert.deepEqual(parseEnvVars('A='), { A: '' })
})

test('last duplicate wins', () => {
    assert.deepEqual(parseEnvVars('A=1\nA=2'), { A: '2' })
})

test('accepts a plain object, converting numbers and booleans', () => {
    assert.deepEqual(parseEnvVars({ A: 'x', B: 2, C: true }), { A: 'x', B: '2', C: 'true' })
})

test('rejects object values that are not scalars', () => {
    assert.throws(() => parseEnvVars({ A: { nested: 1 } }), /must be a string/)
    assert.throws(() => parseEnvVars({ A: ['x'] }), /must be a string/)
    assert.throws(() => parseEnvVars({ A: null }), /must be a string/)
})

test('rejects wrong input types instead of crashing', () => {
    assert.throws(() => parseEnvVars(42), /string \(.env format\) or an object/)
    assert.throws(() => parseEnvVars(['A=1']), /string \(.env format\) or an object/)
})

test('rejects invalid variable names', () => {
    assert.throws(() => parseEnvVars('1BAD=x'), /Line 1: invalid variable name/)
    assert.throws(() => parseEnvVars('A=1\nBAD-NAME=x'), /Line 2: invalid variable name/)
    assert.throws(() => parseEnvVars('=x'), /Line 1: invalid variable name/)
    assert.throws(() => parseEnvVars('FOO --privileged=x'), /invalid variable name/)
    assert.throws(() => parseEnvVars({ 'BAD KEY': 'x' }), /Entry 1: invalid variable name/)
})

test('rejects a line with no "="', () => {
    assert.throws(() => parseEnvVars('A=1\nDEBUG'), /Line 2: expected KEY=value/)
})

test('PORT is reserved', () => {
    assert.throws(() => parseEnvVars('PORT=8080'), /PORT is not allowed/)
    assert.throws(() => parseEnvVars({ PORT: 8080 }), /PORT is not allowed/)
})

test('enforces limits', () => {
    const many = Array.from({ length: MAX_KEYS + 1 }, (_, i) => `K${i}=x`).join('\n')
    assert.throws(() => parseEnvVars(many), /Too many/)
    assert.doesNotThrow(() => parseEnvVars(many.split('\n').slice(0, MAX_KEYS).join('\n')))

    assert.throws(() => parseEnvVars(`A=${'x'.repeat(MAX_VALUE_LENGTH + 1)}`), /too long/)
    assert.throws(() => parseEnvVars({ A: 'a\0b' }), /invalid character/)
})

test('error messages never contain the input (a bad line is often a pasted secret)', () => {
    const secret = 'sk_live_SUPERSECRET123'
    for (const input of [secret, `${secret}x=1`, `A=1\n${secret}`, { [secret]: 'v' }, `1${secret}=v`]) {
        try {
            parseEnvVars(input)
            assert.fail('expected a throw')
        } catch (err) {
            assert.ok(!err.message.includes('SUPERSECRET'), `leaked in: ${err.message}`)
        }
    }
    // a too-long value must not be echoed either
    assert.throws(() => parseEnvVars(`A=${'s3cr3t'.repeat(1000)}`), (err) => !err.message.includes('s3cr3t'))
})
