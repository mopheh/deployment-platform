import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDockerfile } from './docker.js'

function repoDir(files = { 'package.json': '{}' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dockerfile-test-'))
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
    return dir
}
const read = (dir) => fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8')

test('generated node Dockerfile declares one ARG per build variable, before the build step', () => {
    const dir = repoDir()
    const r = ensureDockerfile(dir, { buildArgNames: ['NEXT_PUBLIC_A', 'NEXT_PUBLIC_B'] })
    const df = read(dir)
    assert.equal(r.source, 'generated')
    assert.equal(r.buildArgsApplied, true)
    assert.ok(df.includes('ARG NEXT_PUBLIC_A\nARG NEXT_PUBLIC_B\n'))
    assert.ok(df.indexOf('ARG NEXT_PUBLIC_A') < df.indexOf('RUN npm run build'))
    assert.ok(!df.includes('ENV NEXT_PUBLIC'), 'must not bake the value into the image with ENV')
    assert.ok(!df.includes('BUILD_ARGS'), 'marker must be removed')
})

test('no build variables -> no ARG lines and no leftover marker', () => {
    const dir = repoDir()
    const r = ensureDockerfile(dir, {})
    assert.equal(r.buildArgsApplied, false)
    assert.ok(!read(dir).includes('ARG '))
    assert.ok(!read(dir).includes('BUILD_ARGS'))
})

test("a repo's own Dockerfile is left untouched and reported as not applied", () => {
    const dir = repoDir({ Dockerfile: 'FROM scratch\n' })
    const r = ensureDockerfile(dir, { buildArgNames: ['X'] })
    assert.equal(r.source, 'repo')
    assert.equal(r.buildArgsApplied, false)
    assert.equal(read(dir), 'FROM scratch\n')
})

test('custom dockerfileContent is written as-is and reported as not applied', () => {
    const dir = repoDir()
    const r = ensureDockerfile(dir, { dockerfileContent: 'FROM alpine\n', buildArgNames: ['X'] })
    assert.equal(r.source, 'custom')
    assert.equal(r.buildArgsApplied, false)
    assert.equal(read(dir), 'FROM alpine\n')
})

test('runtimes without a build-arg marker report not applied', () => {
    const dir = repoDir({ 'requirements.txt': 'flask\n' })
    const r = ensureDockerfile(dir, { buildArgNames: ['X'] })
    assert.equal(r.runtime, 'python')
    assert.equal(r.buildArgsApplied, false)
})
