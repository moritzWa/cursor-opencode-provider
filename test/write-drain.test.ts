import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import http2 from "node:http2"
import net from "node:net"
import { CursorLocalCancellationError, CursorProviderError } from "../src/errors.js"
import { pump, resetTurnStateForTests } from "../src/language-model.js"
import { resetClientVersionCache } from "../src/protocol/client-version.js"
import { encodeFrame } from "../src/protocol/framing.js"
import { decodeMessage, encodeMessage } from "../src/protocol/messages.js"
import { sessionManager, type Frame } from "../src/session.js"
import { writeStreamMessage } from "../src/stream-write.js"
import {
  bidiRunStream,
  cacheHttp2SessionForTests,
  closeCachedHttp2SessionsForTests,
} from "../src/transport/connect.js"
import { sessionFixture } from "./session-fixture.js"

// Adapted from the throttling-relay tests in #77 (by @nkoynov).

const ORIGIN = "https://agentn.drain-test.cursor.sh"

/**
 * An h2c "Cursor" behind a relay that forwards what the client sends at
 * `bytesPerSecond`, or nothing once stalled. The server answers each Run with
 * one frame and then stays silent.
 */
async function startSlowCursor(bytesPerSecond: number, options: { endWithoutReading?: boolean } = {}) {
  const received: number[] = []
  const bodies: Buffer[][] = []
  let stalled = false
  const sessions = new Set<http2.Http2Session>()
  const server = http2.createServer()
  server.on("session", (session) => sessions.add(session))
  server.on("stream", (stream) => {
    const index = received.push(0) - 1
    bodies.push([])
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" })
    stream.write(encodeFrame(0x00, new Uint8Array([1, 2, 3])))
    stream.on("error", () => {})
    if (options.endWithoutReading) return void setTimeout(() => stream.end(), 100)
    stream.on("data", (chunk: Buffer) => {
      received[index]! += chunk.length
      bodies[index]!.push(chunk)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const serverPort = (server.address() as net.AddressInfo).port

  const sockets = new Set<net.Socket>()
  const timers = new Set<ReturnType<typeof setInterval>>()
  const relay = net.createServer((client) => {
    const upstream = net.connect(serverPort, "127.0.0.1")
    sockets.add(client).add(upstream)
    const queue: Buffer[] = []
    const tick = setInterval(() => {
      if (stalled) return void client.pause()
      let budget = bytesPerSecond / 20
      while (queue.length > 0 && budget > 0) {
        const head = queue[0]!
        const sent = head.subarray(0, budget)
        upstream.write(sent)
        budget -= sent.length
        if (sent.length === head.length) queue.shift()
        else queue[0] = head.subarray(sent.length)
      }
      if (queue.length > 4) client.pause()
      else client.resume()
    }, 50)
    timers.add(tick)
    client.on("data", (chunk) => queue.push(chunk))
    upstream.on("data", (chunk) => client.write(chunk))
    client.on("error", () => {})
    upstream.on("error", () => {})
  })
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve))
  const relayPort = (relay.address() as net.AddressInfo).port
  const client = http2.connect(ORIGIN, { createConnection: () => net.connect(relayPort, "127.0.0.1") })
  client.on("error", () => {})
  await new Promise<void>((resolve, reject) => {
    client.once("connect", () => resolve())
    client.once("error", reject)
  })
  cacheHttp2SessionForTests(ORIGIN, client)

  return {
    received,
    body: (index: number) => Buffer.concat(bodies[index] ?? []),
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

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(() => undefined, (error: unknown) => error)
}

async function waitUntil(condition: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition() && Date.now() < end;) await new Promise((r) => setTimeout(r, 10))
}

let fake: Awaited<ReturnType<typeof startSlowCursor>> | undefined
const savedClientVersion = process.env.CURSOR_CLIENT_VERSION

beforeEach(() => {
  process.env.CURSOR_CLIENT_VERSION = "cli-drain-test-1"
  resetClientVersionCache()
})

afterEach(async () => {
  sessionManager.dispose()
  resetTurnStateForTests()
  closeCachedHttp2SessionsForTests()
  await fake?.close()
  fake = undefined
  if (savedClientVersion === undefined) delete process.env.CURSOR_CLIENT_VERSION
  else process.env.CURSOR_CLIENT_VERSION = savedClientVersion
  resetClientVersionCache()
})

describe("Run write drain", () => {
  it("answers a large KV get_blob whose reply takes longer than five seconds to upload", async () => {
    fake = await startSlowCursor(800_000)
    const stream = await bidiRunStream("token", { baseURL: ORIGIN })
    const blobId = Uint8Array.of(0xb1, 0x0b)
    const blob = new Uint8Array(5_000_000).map((_, i) => i % 241)
    const frames: Frame[] = [
      { kv_server_message: { id: 4, get_blob_args: { blob_id: blobId } } },
      { interaction_update: { turn_ended: { input_tokens: 1, output_tokens: 1 } } },
    ].map((message) => ({ flags: 0, payload: encodeMessage("AgentServerMessage", message) }))
    const iterator = { next: async () =>
      frames.length ? { done: false as const, value: frames.shift()! } : { done: true as const, value: undefined } }
    const session = sessionFixture({
      sessionId: "kv-drain", conversationId: "kv-drain-conversation",
      pending: new Map(), blobs: new Map([["b10b", blob]]), displayToolCalls: new Map(), editToolCalls: new Map(),
      nextBridgedExecId: 900_000, pumpActive: false, heartbeat: null,
      usageEstimate: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 },
      stream, frames: iterator, allowTools: false, toolCatalog: [], toolDescriptors: [], requestContext: {},
    })
    const controller = {
      enqueue() {}, error(error: Error) { throw error },
    } as unknown as ReadableStreamDefaultController<any>

    const startedAt = Date.now()
    await pump(session, controller, { textId: "t", reasoningId: "r" })

    expect(Date.now() - startedAt).toBeGreaterThan(5_000)
    await waitUntil(() => fake!.received[0]! >= blob.length)
    const reply = decodeMessage<any>("AgentClientMessage", fake.body(0).subarray(5))
    expect(reply.kv_client_message.id).toBe(4)
    expect(reply.kv_client_message.get_blob_result.blob_data).toEqual(blob)
    stream.end()
  }, 20_000)

  it("resolves at once when the write was not backpressured", async () => {
    fake = await startSlowCursor(2_000_000)
    const run = await bidiRunStream("token", { baseURL: ORIGIN })

    expect(run.write(new Uint8Array(1_000))).toBe(true)
    await run.waitForDrain!()
    run.end()
  })

  it("settles a pending drain at once when the Run is aborted", async () => {
    fake = await startSlowCursor(200_000)
    const controller = new AbortController()
    const run = await bidiRunStream("token", { baseURL: ORIGIN, signal: controller.signal })

    expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
    const drain = failureOf(run.waitForDrain!())
    await waitUntil(() => fake!.received[0]! > 50_000)
    const startedAt = Date.now()
    controller.abort()
    const error = await drain

    expect(error).toBeInstanceOf(CursorLocalCancellationError)
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  }, 15_000)

  it("settles a pending drain at once when the Run is destroyed or ended", async () => {
    for (const close of ["destroy", "end"] as const) {
      fake = await startSlowCursor(200_000)
      const run = await bidiRunStream("token", { baseURL: ORIGIN })

      expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
      const drain = failureOf(writeStreamMessage(run, new Uint8Array(10), `after-${close}`))
      const pending = failureOf(run.waitForDrain!())
      await waitUntil(() => fake!.received[0]! > 50_000)
      fake.stall()
      const startedAt = Date.now()
      run[close]()

      expect(await pending).toBeInstanceOf(CursorLocalCancellationError)
      expect(Date.now() - startedAt).toBeLessThan(1_000)
      await drain
      expect(await failureOf(run.waitForDrain!())).toBeInstanceOf(CursorLocalCancellationError)
      closeCachedHttp2SessionsForTests()
      await fake.close()
      fake = undefined
    }
  }, 15_000)

  it("settles a pending drain when Cursor ends its response without reading the request", async () => {
    fake = await startSlowCursor(200_000, { endWithoutReading: true })
    const run = await bidiRunStream("token", { baseURL: ORIGIN })

    expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
    const error = await failureOf(run.waitForDrain!())

    expect(error).toBeInstanceOf(CursorProviderError)
    expect(error).not.toBeInstanceOf(CursorLocalCancellationError)
    expect(await failureOf(run.waitForDrain!())).toBeInstanceOf(CursorProviderError)
  }, 5_000)

  it("leaves a stalled write to the read-idle watchdog", async () => {
    fake = await startSlowCursor(200_000)
    const run = await bidiRunStream("token", { baseURL: ORIGIN, readIdleMs: 500 })

    expect(run.write(new Uint8Array(3_000_000).fill(5))).toBe(false)
    const drain = failureOf(run.waitForDrain!())
    await waitUntil(() => fake!.received[0]! > 50_000)
    fake.stall()
    const error = await drain

    expect(error).toBeInstanceOf(CursorProviderError)
    expect((error as CursorProviderError).code).toBe("CURSOR_READ_IDLE_TIMEOUT")
    expect(run.isClosed()).toBe(true)
  }, 15_000)
})
