import assert from "node:assert/strict"
import http2 from "node:http2"
import net from "node:net"
import {
  bidiRunStream,
  cacheHttp2SessionForTests,
  closeCachedHttp2SessionsForTests,
} from "../dist/transport/connect.js"
import { encodeFrame } from "../dist/protocol/framing.js"
import { writeStreamMessage } from "../dist/stream-write.js"

// Node keeps a large write's full size buffered until it is out and holds back
// a stream's `close` while it is, so the drain is checked on Node as well as
// Bun. Adapted from the relay tests in #77 (by @nkoynov).
process.env.CURSOR_CLIENT_VERSION = "cli-node-drain-test-1"
const ORIGIN = "https://agentn.node-drain-test.cursor.sh"
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const failureOf = (promise) => promise.then(() => undefined, (error) => error)
const waitUntil = async (condition, ms = 5_000) => {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await sleep(10)
}

async function startSlowCursor(bytesPerSecond, { endWithoutReading = false } = {}) {
  const received = []
  let stalled = false
  const sessions = new Set()
  const server = http2.createServer()
  server.on("session", (session) => sessions.add(session))
  server.on("stream", (stream) => {
    const index = received.push(0) - 1
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
    stream.on("error", () => {})
    if (endWithoutReading) return void setTimeout(() => stream.end(), 100)
    stream.on("data", (chunk) => { received[index] += chunk.length })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const sockets = new Set()
  const timers = new Set()
  const relay = net.createServer((client) => {
    const upstream = net.connect(server.address().port, "127.0.0.1")
    sockets.add(client).add(upstream)
    const queue = []
    timers.add(setInterval(() => {
      if (stalled) return void client.pause()
      let budget = bytesPerSecond / 20
      while (queue.length > 0 && budget > 0) {
        const sent = queue[0].subarray(0, budget)
        upstream.write(sent)
        budget -= sent.length
        if (sent.length === queue[0].length) queue.shift()
        else queue[0] = queue[0].subarray(sent.length)
      }
      if (queue.length > 4) client.pause()
      else client.resume()
    }, 50))
    client.on("data", (chunk) => queue.push(chunk))
    upstream.on("data", (chunk) => client.write(chunk))
    client.on("error", () => {})
    upstream.on("error", () => {})
  })
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const client = http2.connect(ORIGIN, { createConnection: () => net.connect(relay.address().port, "127.0.0.1") })
  client.on("error", () => {})
  await new Promise((resolve, reject) => {
    client.once("connect", resolve)
    client.once("error", reject)
  })
  cacheHttp2SessionForTests(ORIGIN, client)
  return {
    received,
    stall() { stalled = true },
    async close() {
      for (const timer of timers) clearInterval(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => relay.close(resolve))
      for (const session of sessions) session.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

async function scenario(name, rate, run, options) {
  const fake = await startSlowCursor(rate, options)
  try {
    await run(fake)
  } finally {
    closeCachedHttp2SessionsForTests()
    await fake.close()
  }
  console.log(`node-http2-drain ${name}=ok`)
}

await scenario("slow-upload", 500_000, async (fake) => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  const request = new Uint8Array(3_000_000).fill(5)
  const startedAt = Date.now()
  await writeStreamMessage(run, request, "test request")
  assert.ok(Date.now() - startedAt > 5_000)
  await waitUntil(() => fake.received[0] === 5 + request.length)
  assert.equal(fake.received[0], 5 + request.length)
  run.end()
})

await scenario("abort", 200_000, async (fake) => {
  const controller = new AbortController()
  const run = await bidiRunStream("token", { baseURL: ORIGIN, signal: controller.signal })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  const drain = failureOf(run.waitForDrain())
  await waitUntil(() => fake.received[0] > 50_000)
  const startedAt = Date.now()
  controller.abort()
  const error = await drain
  assert.equal(error?.name, "CursorLocalCancellationError")
  assert.ok(Date.now() - startedAt < 1_000)
})

for (const close of ["destroy", "end"]) {
  await scenario(close, 200_000, async (fake) => {
    const run = await bidiRunStream("token", { baseURL: ORIGIN })
    assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
    const drain = failureOf(run.waitForDrain())
    await waitUntil(() => fake.received[0] > 50_000)
    fake.stall()
    const startedAt = Date.now()
    run[close]()
    const error = await drain
    assert.equal(error?.name, "CursorLocalCancellationError")
    assert.ok(Date.now() - startedAt < 1_000)
  })
}

await scenario("response-end", 200_000, async () => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  const error = await Promise.race([failureOf(run.waitForDrain()), sleep(3_000).then(() => "pending")])
  assert.notEqual(error, "pending")
  assert.ok(error instanceof Error)
  assert.notEqual(error.name, "CursorLocalCancellationError")
}, { endWithoutReading: true })

await scenario("read-idle", 200_000, async (fake) => {
  const run = await bidiRunStream("token", { baseURL: ORIGIN, readIdleMs: 500 })
  assert.equal(run.write(new Uint8Array(3_000_000).fill(5)), false)
  const drain = failureOf(run.waitForDrain())
  await waitUntil(() => fake.received[0] > 50_000)
  fake.stall()
  const error = await drain
  assert.equal(error?.code, "CURSOR_READ_IDLE_TIMEOUT")
  assert.equal(run.isClosed(), true)
})
