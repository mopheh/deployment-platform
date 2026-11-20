import { config } from '../config.js'
import { claimNextJob } from '../db/deployments.js'
import { runDeployment } from './pipeline.js'

let active = 0

// claim jobs until we're at the concurrency limit or the queue is empty
export function tick() {
    try {
        while (active < config.maxWorkers) {
            const job = claimNextJob()
            if (!job) return
            active++
            runDeployment(job)
                .catch((err) => console.error(`[${job.id}] pipeline crashed:`, err))
                .finally(() => { active--; tick() })
        }
    } catch (err) {
        // an exception inside a setInterval callback would crash the whole server
        console.error('worker tick failed:', err)
    }
}

// safety net: picks up recovered jobs after a restart even if no new request arrives
export function startWorker(intervalMs = 3000) {
    tick()
    return setInterval(tick, intervalMs)
}
