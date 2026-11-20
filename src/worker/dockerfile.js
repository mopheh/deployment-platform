import fs from 'fs'
import path from 'path'
const hasDockerfile = (dir) => {
    return fs.existsSync(path.join(dir, 'Dockerfile'))
}

const MARKERS = [
    ['package.json', 'nodejs'],
    ['requirements.txt', 'python'],
    ['Gemfile', 'ruby'],
    ['pom.xml', 'java'],
    ['build.gradle', 'java'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
]
const SKIP = new Set(['node_modules', '.git', 'venv', '.venv', 'vendor', 'dist', 'build', 'target', '__pycache__'])
const MAX_DEPTH = 2


const detectRuntime = (root) => {
    let level = [root]
    for (let depth = 0; depth <= MAX_DEPTH && level.length; depth++) {
        const next = []
        for (const dir of level) {
            const entries = fs.readdirSync(dir, { withFileTypes: true })
            const names = new Set(entries.map((e) => e.name))
            for (const [file, runtime] of MARKERS) {
                if (names.has(file)) return { runtime, appDir: dir }
            }
            for (const e of entries) {
                if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) {
                    next.push(path.join(dir, e.name))
                }
            }
        }
        level = next
    }
    return null
}

const templates = {
    nodejs: `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["npm", "start"]
EXPOSE 3000
`,
    python: `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "app.py"]
EXPOSE 3000
`,
    ruby: `FROM ruby:3.2-slim
WORKDIR /app
COPY Gemfile* ./
RUN bundle install --without development test
COPY . .
CMD ["ruby", "app.rb"]
EXPOSE 3000
`,
    php: `FROM php:8.2-apache
WORKDIR /var/www/html
COPY . .
CMD ["apache2-foreground"]
EXPOSE 80
`,
    java: `FROM openjdk:17-jdk-slim
WORKDIR /app
COPY . .
RUN ./gradlew build -x test
CMD ["java", "-jar", "build/libs/app.jar"]
EXPOSE 3000
`,
    rust: `FROM rust:1.72-slim
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN cargo fetch --locked
COPY src ./src
RUN cargo build --release
CMD ["./target/release/app"]
EXPOSE 3000
`,
    go: `FROM golang:1.21-alpine
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o app .
CMD ["./app"]
EXPOSE 3000
`
}


const ensureDockerfile = (dir, options = {}) => {
    if (hasDockerfile(dir)) {
        return { source: "repo", appDir: dir }
    }

    if (options.dockerfileContent) {
        fs.writeFileSync(path.join(dir, 'Dockerfile'), options.dockerfileContent)
        return { source: "custom", appDir: dir }
    }

    const found = detectRuntime(dir)
    if (!found) {
        // can't help — tell the user exactly what to do
        throw new Error(
            'No Dockerfile found and runtime could not be detected. ' +
            'Add a Dockerfile to your repo, or include dockerfileContent in your request.'
        )
    }

    fs.writeFileSync(path.join(found.appDir, 'Dockerfile'), templates[found.runtime])
    return { source: "generated", runtime: found.runtime, appDir: found.appDir }
}
export { ensureDockerfile, hasDockerfile, detectRuntime }