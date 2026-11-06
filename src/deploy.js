import { spawn } from 'child_process'

function runCommand(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env: { ...process.env, ...options.env },
            cwd: options.cwd || process.cwd(),
        })
        const logs = []

        // a chunk can hold several lines, or end mid-line; buffer and emit whole lines
        const makeHandler = () => {
            let buffer = ''
            const emit = (line) => {
                line = line.trim()
                if (!line) return
                logs.push(line)
                if (options.onLog) options.onLog(line)
            }
            return {
                onData: (data) => {
                    buffer += data.toString()
                    const parts = buffer.split(/\r?\n|\r/)
                    buffer = parts.pop()
                    parts.forEach(emit)
                },
                flush: () => {
                    emit(buffer)
                    buffer = ''
                },
            }
        }

        const out = makeHandler()
        const err = makeHandler()
        child.stdout.on('data', out.onData)
        child.stderr.on('data', err.onData)

        // e.g. ENOENT when the binary isn't installed; without this the process crashes
        child.on('error', (error) => {
            reject(new Error(`Failed to start '${command}': ${error.message}`))
        })

        child.on('close', (code) => {
            out.flush()
            err.flush()
            if (code === 0) {
                resolve(logs)
            } else {
                reject(new Error(`Command failed with exit code ${code}`))
            }
        })
    })
}

export { runCommand }
