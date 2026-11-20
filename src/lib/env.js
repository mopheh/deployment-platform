const KEY_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/
const MAX_KEYS = 50
const MAX_VALUE_LENGTH = 4096


function parseEnvVars(input) {
    let entries // [[key, value, label], ...] 

    if (input === undefined || input === null) return {}
    if (typeof input === 'string') entries = entriesFromText(input)
    else if (isPlainObject(input)) entries = entriesFromObject(input)
    else throw new Error('Environment variables must be a string (.env format) or an object')

    const envVars = {}
    for (const [key, value, label] of entries) {
        if (!KEY_REGEX.test(key)) throw new Error(`${label}: invalid variable name`)
        if (key === 'PORT') throw new Error('Setting PORT is not allowed')
        if (value.length > MAX_VALUE_LENGTH) throw new Error(`${label}: value is too long (max ${MAX_VALUE_LENGTH} characters)`)
        if (value.includes('\0')) throw new Error(`${label}: value contains an invalid character`)
        envVars[key] = value // a repeated key: the last one wins, like dotenv
    }

    if (Object.keys(envVars).length > MAX_KEYS) {
        throw new Error(`Too many environment variables (max ${MAX_KEYS})`)
    }
    return envVars
}

function entriesFromText(text) {
    const entries = []
    // \r?\n so files saved on Windows work
    text.split(/\r?\n/).forEach((rawLine, i) => {
        let line = rawLine.trim()
        if (!line || line.startsWith('#')) return // skip empty lines and comments

        const label = `Line ${i + 1}`
        if (line.startsWith('export ')) line = line.slice('export '.length).trimStart()

        const eq = line.indexOf('=') // split on the FIRST '=' only: values may contain '='
        if (eq === -1) throw new Error(`${label}: expected KEY=value`)

        entries.push([line.slice(0, eq).trim(), unquote(line.slice(eq + 1).trim()), label])
    })
    return entries
}

function entriesFromObject(obj) {
    return Object.entries(obj).map(([key, value], i) => {
        const label = `Entry ${i + 1}`
        if (typeof value === 'number' || typeof value === 'boolean') value = String(value)
        if (typeof value !== 'string') throw new Error(`${label}: value must be a string`)
        return [key, value, label]
    })
}

// "a b" or 'a b' -> a b   (one matching pair only; inline # comments are NOT stripped
// because a value may legitimately contain '#')
function unquote(value) {
    const first = value[0]
    if (value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first) {
        return value.slice(1, -1)
    }
    return value
}

function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export { parseEnvVars, MAX_KEYS, MAX_VALUE_LENGTH }
