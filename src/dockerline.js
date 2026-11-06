import fs from 'fs'
import path from 'path'
const hasDockerfile = (dir) => {
    return fs.existsSync(path.join(dir, 'Dockerfile'))
}

const detectRuntime = (dir) => {
    const files = fs.readdirSync(dir)

    if (files.includes('package.json')) return 'nodejs'
    if (files.includes('requirements.txt')) return 'python'
    if (files.includes('Gemfile')) return 'ruby'
    if (files.includes('pom.xml')) return 'java'
    if (files.includes('build.gradle')) return 'java'
    if (files.includes('Cargo.toml')) return 'rust'
    if (files.includes('go.mod')) return 'go'

    return null

}

const templates = {
    nodejs: `FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "index.js"]
`,
    python: `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "app.py"]
`,
    ruby: `FROM ruby:3.2-slim
WORKDIR /app
COPY Gemfile* ./
RUN bundle install --without development test
COPY . .
CMD ["ruby", "app.rb"]
`,
    java: `FROM openjdk:17-jdk-slim
WORKDIR /app
COPY . .
RUN ./gradlew build -x test
CMD ["java", "-jar", "build/libs/app.jar"]
`,
    rust: `FROM rust:1.72-slim
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN cargo fetch --locked
COPY src ./src
RUN cargo build --release
CMD ["./target/release/app"]
`,
    go: `FROM golang:1.21-alpine
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o app .
CMD ["./app"]
`
}


const ensureDockerfile = (dir, options = {}) => {
    if (hasDockerfile(dir)) {
        return { source: "repo" }
    }

    if (options.dockerfileContent) {
        fs.writeFileSync(path.join(dir, 'Dockerfile'), options.dockerfileContent)
        return { source: "custom" }
    }

    const runtime = detectRuntime(dir)
    if (!runtime) {
        // can't help — tell the user exactly what to do
        throw new Error(
            'No Dockerfile found and runtime could not be detected. ' +
            'Add a Dockerfile to your repo, or include dockerfileContent in your request.'
        )
    }

    const content = templates[runtime]
    fs.writeFileSync(path.join(dir, 'Dockerfile'), content)
    return { source: "generated", runtime }
}
export { ensureDockerfile, hasDockerfile, detectRuntime }