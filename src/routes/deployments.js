import { Router } from 'express'
import crypto from 'crypto'
import { createDeployment, getDeployment, getLogs } from '../db/deployments.js'
import { TERMINAL, getLive, sseSend } from '../realtime/live.js'
import { publicUrl } from '../lib/url.js'
import { parseEnvVars } from '../lib/env.js'
import { tick } from '../worker/worker.js'

const router = Router()

// only allow http(s)/git URLs so a value like "--upload-pack=..." can't be parsed as a git option
const isValidRepoUrl = (url) =>
    typeof url === 'string' && /^(https?:\/\/|git:\/\/|ssh:\/\/|git@)/.test(url)

router.post('/deploy', (req, res) => {
    const { repoUrl, dockerfileContent } = req.body ?? {}

    if (!repoUrl) {
        return res.status(400).json({ error: 'repoUrl is required' })
    }
    if (!isValidRepoUrl(repoUrl)) {
        return res.status(400).json({ error: 'repoUrl must be an http(s), git, or ssh URL' })
    }
    if (dockerfileContent != null && typeof dockerfileContent !== 'string') {
        return res.status(400).json({ error: 'dockerfileContent must be a string' })
    }

    // env = runtime variables (docker run -e); buildEnv = build-time args (docker build --build-arg).
    // Each may be a .env-format string or an object. Validate both BEFORE creating anything.
    let env, buildEnv
    try {
        env = parseEnvVars(req.body.env)
    } catch (err) {
        return res.status(400).json({ error: `env: ${err.message}` })
    }
    try {
        buildEnv = parseEnvVars(req.body.buildEnv)
    } catch (err) {
        return res.status(400).json({ error: `buildEnv: ${err.message}` })
    }

    const deploymentId = `deploy-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`

    getLive(deploymentId)
    createDeployment(deploymentId, repoUrl, { dockerfileContent: dockerfileContent || null, env, buildEnv })
    res.json({ deploymentId, status: 'queued', url: publicUrl(deploymentId) })

    tick() // wake the worker so the job starts without waiting for the next poll
})

router.get('/deploy/:id', (req, res) => {
    const deployment = getDeployment(req.params.id)
    if (!deployment) {
        return res.status(404).json({ error: 'Deployment not found' })
    }

    res.json({
        deploymentId: req.params.id,
        status: deployment.status,
        url: deployment.status === 'running' ? publicUrl(req.params.id) : null,
    })
})

router.get('/deploy/:id/logs', (req, res) => {
    const deployment = getDeployment(req.params.id)
    if (!deployment) {
        return res.status(404).json({ error: 'Deployment not found' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // replay what's already stored
    getLogs(req.params.id).forEach((line) => {
        sseSend(res, { type: 'log', deploymentId: req.params.id, line })
    })

    // already finished: send the final status and close
    if (TERMINAL.has(deployment.status)) {
        sseSend(res, {
            type: 'status',
            deploymentId: req.params.id,
            status: deployment.status,
            ...(deployment.status === 'running' && { url: publicUrl(req.params.id) }),
        })
        return res.end()
    }

    const live = getLive(req.params.id) // exists while queued too, so the client waits instead of being dropped
    live.clients.push(res)

    req.on('close', () => {
        live.clients = live.clients.filter((client) => client !== res)
    })
})

export default router
