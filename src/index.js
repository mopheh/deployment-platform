import express from 'express'
import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { runCommand } from './deploy.js'
import { ensureDockerfile } from './dockerline.js'
import { createHostRouter, createUpgradeHandler } from './routing.js'
import {
    createDeployment, updateStatus,
    appendLog, getDeployment, getLogs,
    setDockerfileInfo, failStaleDeployments,
    setContainerInfo
} from './db.js'

const app = express()

// must come first: routes <id>.<PLATFORM_HOST> to deployments before any body parsing or API routes
const PLATFORM_HOST = process.env.PLATFORM_HOST || 'localhost'
app.use(createHostRouter({ platformHost: PLATFORM_HOST, getDeployment }))

app.use(express.json())

failStaleDeployments() // mark any stale deployments as failed on startup

const deployments = {} // store deployment statuses in memory for simplicity
const TERMINAL = new Set(['running', 'complete', 'failed'])

// only allow http(s)/git URLs so a value like "--upload-pack=..." can't be parsed as a git option
const isValidRepoUrl = (url) =>
    typeof url === 'string' && /^(https?:\/\/|git:\/\/|ssh:\/\/|git@)/.test(url)

function sseSend(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
})

app.post('/deploy', async (req, res) => {
    const { repoUrl } = req.body

    if (!repoUrl) {
        return res.status(400).json({ error: 'repoUrl is required' })
    }
    if (!isValidRepoUrl(repoUrl)) {
        return res.status(400).json({ error: 'repoUrl must be an http(s), git, or ssh URL' })
    }

    // generate a simple unique ID for this deployment
    const deploymentId = `deploy-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`
    const buildDir = path.join('/tmp', 'builds', deploymentId)

    // make sure the builds directory exists
    fs.mkdirSync(buildDir, { recursive: true })

    console.log(`[${deploymentId}] Starting deployment of ${repoUrl}`)

    // respond immediately — the build happens in the background
    createDeployment(deploymentId, repoUrl)
    res.json({ deploymentId, status: 'cloning' })
    deployments[deploymentId] = { status: 'cloning', logs: [], clients: [] }


    function pushLog(line) {
        appendLog(deploymentId, line)
        deployments[deploymentId].logs.push(line)
        deployments[deploymentId].clients.forEach((client) => {
            sseSend(client, { type: 'log', deploymentId, line })
        })
    }

    function pushStatus(status) {
        updateStatus(deploymentId, status)
        const d = deployments[deploymentId]
        d.status = status
        d.clients.forEach((client) => {
            sseSend(client, { type: 'status', deploymentId, status })
            // close streams once the deployment is finished
            if (TERMINAL.has(status)) client.end()
        })
        if (TERMINAL.has(status)) d.clients = []
    }

    try {
        await runCommand('git', ['clone', '--', repoUrl, buildDir], {
            onLog: (line) => {
                console.log(`[${deploymentId}] ${line.trim()}`)
                pushLog(line.trim())
            }
        })
        console.log(`[${deploymentId}] Clone successful`)
        pushStatus('cloned')
        let dockerfileResult;
        try {
            dockerfileResult = ensureDockerfile(buildDir, { dockerfileContent: req.body.dockerfileContent })
            pushLog(`Dockerfile Ready: {source: ${dockerfileResult.source}}${dockerfileResult.runtime ? `, runtime: ${dockerfileResult.runtime}` : ''}`)
            setDockerfileInfo(deploymentId, dockerfileResult.source, dockerfileResult.runtime)
        } catch (error) {
            pushLog(error.message)
            pushStatus('failed')
            return
        }

        pushStatus('building')
        await runCommand('docker', ['build', '-t', `myapp:${deploymentId}`, dockerfileResult.appDir], {
            cwd: dockerfileResult.appDir,
            onLog: (line) => {
                pushLog(line.trim())
            }
        })

        // pushStatus('complete')
        console.log(`[${deploymentId}] Deployment complete`)
        console.log(`[${deploymentId}] Docker image: myapp:${deploymentId}`)
        console.log(`Opening a container shell.....`)
        const name = `app-${deploymentId}`
        await runCommand('docker', [
            'run', '-d', '--name', name, '-e', 'PORT=3000', '-p', '127.0.0.1::3000', `myapp:${deploymentId}`
        ])

        const [mapping] = await runCommand('docker', ['port', name, '3000/tcp'], { captureOutput: true, onLog: pushLog })
        const dockerPort = Number(mapping.trim().split(':')[1])
        const isInteger = Number.isInteger(dockerPort)
        if (!isInteger || dockerPort < 1 || dockerPort > 65535) {
            setContainerInfo(deploymentId, null, name)
            throw new Error(`Invalid host port mapping for container ${name}. Received: ${mapping.trim()}`)
        } else {
            setContainerInfo(deploymentId, dockerPort, name)
        }
        pushStatus('running')
        console.log(`[${deploymentId}] Container started: http://${mapping.trim()}`)
        console.log(`[${deploymentId}] Container running: ${name}`)
        console.log(`[${deploymentId}] Port mapping: ${mapping.trim()}`)

    } catch (err) {
        console.error(`[${deploymentId}] Deployment failed:`, err.message)
        pushLog(`Error: ${err.message}`)
        getDeployment(deploymentId).status === 'complete' ? pushStatus('complete') : getDeployment(deploymentId).status === 'running' ? pushStatus('failed') : pushStatus('failed')
    }
})

app.get('/deploy/:id', (req, res) => {
    const deployment = getDeployment(req.params.id)
    if (!deployment) {
        return res.status(404).json({ error: 'Deployment not found' })
    }

    res.json({ deploymentId: req.params.id, status: deployment.status })
})


app.get('/deploy/:id/logs', (req, res) => {
    const live = deployments[req.params.id]
    const deployment = getDeployment(req.params.id)
    if (!deployment) {
        return res.status(404).json({ error: 'Deployment not found' })
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    // send existing logs
    const logs = getLogs(req.params.id)
    logs.forEach((line) => {
        sseSend(res, { type: 'log', deploymentId: req.params.id, line })
    })

    // already finished: send the final status and close
    if (TERMINAL.has(deployment.status) || !live) {
        sseSend(res, { type: 'status', deploymentId: req.params.id, status: deployment.status })
        return res.end()
    }

    live.clients.push(res)

    req.on('close', () => {
        live.clients = live.clients.filter((client) => client !== res)
    })
})


const server = app.listen(3000, () => {
    console.log('Platform server running on port 3000')
})

// WebSocket / Upgrade requests never reach Express; Node emits them separately
server.on('upgrade', createUpgradeHandler({ platformHost: PLATFORM_HOST, getDeployment }))
