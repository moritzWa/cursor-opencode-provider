import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Each case runs in a child process against a local HTTP/2 server whose own
// handles are unref'd, so only the client session can keep the process alive.
// The Runs go in an un-awaited function: Bun keeps a process alive while a
// top-level await is pending, which would hide an early unref.

const CONNECT_MODULE = pathToFileURL(path.resolve(import.meta.dir, "../src/transport/connect.ts")).href

const PRELUDE = `
import http2 from "node:http2"
import { bidiRunStream, cacheHttp2SessionForTests } from ${JSON.stringify(CONNECT_MODULE)}

const ORIGIN = "https://agentn.session-exit-test.cursor.sh"
const server = http2.createServer()
server.on("session", (session) => session.unref())
const streams = []
const arrivals = []
// Resolves with the server side of the nth Run once it has arrived.
function serverStream(n) {
  if (streams.length >= n) return Promise.resolve(streams[n - 1])
  return new Promise((resolve) => arrivals.push({ n, resolve }))
}
server.on("stream", (stream) => {
  stream.respond({ ":status": 200 })
  stream.on("error", () => {})
  stream.on("data", () => {})
  stream.on("end", () => stream.end())
  streams.push({ stream, closed: new Promise((resolve) => stream.once("close", resolve)) })
  onServerStream(stream, streams.length)
  for (const arrival of arrivals.filter((waiter) => waiter.n <= streams.length)) {
    arrivals.splice(arrivals.indexOf(arrival), 1)
    arrival.resolve(streams[arrival.n - 1])
  }
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
server.unref()

const client = http2.connect("http://127.0.0.1:" + server.address().port)
await new Promise((resolve, reject) => {
  client.once("connect", resolve)
  client.once("error", reject)
})
cacheHttp2SessionForTests(ORIGIN, client)
`

function childScript(onServerStream: string, runs: string): string {
  return `${onServerStream}
${PRELUDE}
void (async () => {
${runs}
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
`
}

// Two Runs one after the other; the second reuses the cached session after a
// ping. The process must exit once the last one has closed.
const SEQUENTIAL_RUNS = childScript(`function onServerStream() {}`, `
for (let turn = 1; turn <= 2; turn++) {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  run.end()
  await (await serverStream(turn)).closed
}
console.log("done")
`)

// Two overlapping Runs. The first closes; the second is answered only after an
// unref'd delay, so nothing but its own live stream keeps the process alive
// until the answer arrives.
const OVERLAPPING_RUNS = childScript(`
function onServerStream(stream, index) {
  if (index !== 2) return
  void serverStream(1).then((first) => first.closed).then(() => {
    setTimeout(() => {
      // One Connect frame: flags 0, length 1, payload 0x2a.
      stream.write(Uint8Array.of(0, 0, 0, 0, 1, 42))
    }, 200).unref()
  })
}`, `
const first = await bidiRunStream("token", { baseURL: ORIGIN })
const second = await bidiRunStream("token", { baseURL: ORIGIN })
first.end()
await (await serverStream(1)).closed
const frame = await second.frames().next()
console.log("second answered: " + frame.value?.payload[0])
second.end()
await (await serverStream(2)).closed
console.log("done")
`)

async function runUntilExit(
  script: string,
  timeoutMs: number,
): Promise<{ exited: boolean; code: number | null; stdout: string; stderr: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-provider-session-exit-"))
  try {
    const file = path.join(directory, "run.ts")
    await fs.writeFile(file, script)
    const child = Bun.spawn([process.execPath, file], {
      env: { ...process.env, CURSOR_CLIENT_VERSION: "cli-session-exit-test" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = new Response(child.stdout).text()
    const stderr = new Response(child.stderr).text()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs)
    })
    const outcome = await Promise.race([child.exited, timedOut])
    clearTimeout(timer)
    if (outcome === "timeout") child.kill()
    const code = await child.exited
    return {
      exited: outcome !== "timeout",
      code: outcome === "timeout" ? null : code,
      stdout: await stdout,
      stderr: await stderr,
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

describe("cached HTTP/2 session and process exit", () => {
  it("lets a process end once its last Run has finished", async () => {
    const result = await runUntilExit(SEQUENTIAL_RUNS, 8_000)
    expect(result).toMatchObject({ exited: true, code: 0, stdout: "done\n" })
  }, 15_000)

  it("keeps the process alive while a sibling Run is still open", async () => {
    const result = await runUntilExit(OVERLAPPING_RUNS, 8_000)
    expect(result).toMatchObject({ exited: true, code: 0, stdout: "second answered: 42\ndone\n" })
  }, 15_000)
})
