import path from 'path'
import fs from 'fs'
import { config } from '../config.js'
import { runCommand } from '../lib/exec.js'
import { publicUrl } from '../lib/url.js'
import { ensureDockerfile } from './docker.js'
import { appendLog, updateStatus, setDockerfileInfo, setContainerInfo } from '../db/deployments.js'
import { TERMINAL, getLive, sseSend } from '../realtime/live.js'

export async function runDeployment(job) {

    const { id: deploymentId, repo_url: repoUrl, dockerfile_content: dockerfileContent } = job



    console.log(`[${deploymentId}] Starting deployment of ${repoUrl}`)


    function pushLog(line) {
        appendLog(deploymentId, line)
        const d = getLive(deploymentId)
        d.logs.push(line)
        d.clients.forEach((client) => {
            sseSend(client, { type: 'log', deploymentId, line })
        })
    }

    function pushStatus(status) {
        updateStatus(deploymentId, status)
        const d = getLive(deploymentId)
        d.status = status
        d.clients.forEach((client) => {
            sseSend(client, { type: 'status', deploymentId, status, ...(status === 'running' && { url: publicUrl(deploymentId) }) })
            // close streams once the deployment is finished
            if (TERMINAL.has(status)) client.end()
        })
        if (TERMINAL.has(status)) d.clients = []
    }

    try {
        const buildEnv = JSON.parse(job.build_env_json) || {}
        const env = JSON.parse(job.env_json) || {}
        const buildArgv = Object.entries(buildEnv).flatMap(([key, value]) => ['--build-arg', `${key}=${value}`])
        const runArgv = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
        const buildDir = path.join(config.buildsDir, deploymentId)

        // a retried job may have a half-filled directory, and git clone refuses a non-empty one
        fs.rmSync(buildDir, { recursive: true, force: true })
        fs.mkdirSync(buildDir, { recursive: true })
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
            dockerfileResult = ensureDockerfile(buildDir, { dockerfileContent, buildArgNames: Object.keys(buildEnv) })
            pushLog(`Dockerfile Ready: {source: ${dockerfileResult.source}}${dockerfileResult.runtime ? `, runtime: ${dockerfileResult.runtime}` : ''}`)
            setDockerfileInfo(deploymentId, dockerfileResult.source, dockerfileResult.runtime)
            if (Object.keys(buildEnv).length && !dockerfileResult.buildArgsApplied) {
                pushLog(`Warning: buildEnv has no effect unless the Dockerfile declares ARG ${Object.keys(buildEnv).join(', ARG ')}`)
            }
        } catch (error) {
            pushLog(error.message)
            pushStatus('failed')
            return
        }

        pushStatus('building')
        await runCommand('docker', ['build', '-t', `myapp:${deploymentId}`, ...buildArgv, dockerfileResult.appDir], {
            cwd: dockerfileResult.appDir,
            onLog: (line) => {
                pushLog(line.trim())
            },
        })


        console.log(`[${deploymentId}] Deployment complete`)
        console.log(`[${deploymentId}] Docker image: myapp:${deploymentId}`)
        console.log(`Opening a container shell.....`)
        const name = `app-${deploymentId}`
        // a retried job may have left a container with this name behind
        await runCommand('docker', ['rm', '-f', name]).catch(() => { })
        await runCommand('docker', [
            'run', '-d', '--name', name, ...runArgv, '-e', 'PORT=3000', '-p', '127.0.0.1::3000', `myapp:${deploymentId}`
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
        pushLog(`Live at ${publicUrl(deploymentId)}`)
        pushStatus('running')
        console.log(`[${deploymentId}] Container started: http://${mapping.trim()}`)
        console.log(`[${deploymentId}] Container running: ${name}`)
        console.log(`[${deploymentId}] Port mapping: ${mapping.trim()}`)

    } catch (err) {
        console.error(`[${deploymentId}] Deployment failed:`, err.message)
        pushLog(`Error: ${err.message}`)
        pushStatus('failed')
    }
}