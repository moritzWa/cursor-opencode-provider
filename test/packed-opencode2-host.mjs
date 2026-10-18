/** Optional real-host contract check: bun test/packed-opencode2-host.mjs HOST_ROOT TARBALL.
 * Runs the packed plugin through the host's actual resolver, Promise adapter,
 * schema decoders and Effect tool executor. Services are isolated fixtures;
 * this is not a live model/network acceptance test.
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { execFileSync } from "node:child_process"

const [hostArg, tarArg] = process.argv.slice(2)
assert(hostArg && tarArg, "usage: bun test/packed-opencode2-host.mjs HOST_ROOT TARBALL")
const hostRoot = resolve(hostArg)
const moduleAt = (file) => import(pathToFileURL(join(hostRoot, file)).href)
const hostRequire = createRequire(join(hostRoot, "packages/plugin/package.json"))
const { Effect, Schema, Stream } = await import(pathToFileURL(hostRequire.resolve("effect")).href)
const [{ Host }, { fromPromise }, { Provider }, { Model }] = await Promise.all([
  moduleAt("packages/plugin/src/host.ts"),
  moduleAt("packages/plugin/src/promise/adapter.ts"),
  moduleAt("packages/schema/src/provider.ts"),
  moduleAt("packages/schema/src/model.ts"),
])

const fixture = mkdtempSync(join(tmpdir(), "cursor-packed-host-"))
try {
  process.env.XDG_CACHE_HOME = join(fixture, "cache")
  process.env.XDG_DATA_HOME = join(fixture, "data")
  process.env.OPENCODE_TEST_HOME = fixture
  process.env.CURSOR_OPENCODE2_TODOS = "1"
  mkdirSync(join(fixture, "node_modules"))
  execFileSync("tar", ["-xzf", resolve(tarArg), "-C", fixture])
  const packageRoot = join(fixture, "package")
  symlinkSync(packageRoot, join(fixture, "node_modules/cursor-opencode-provider"))
  // Only production dependencies are visible to the extracted provider. In
  // particular, the optional OpenCode 1.x plugin SDK must not be needed.
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  for (const name of Object.keys(manifest.dependencies)) {
    const target = join(packageRoot, "node_modules", name)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(resolve(import.meta.dirname, "../node_modules", name), target)
  }
  const entry = Host.resolve({ directory: fixture, name: "cursor-opencode-provider" }).server
  assert(entry?.endsWith("dist/plugin-opencode2.js"), `unexpected server entry: ${entry}`)
  const loaded = await Host.load(entry)
  const plugin = loaded.default
  assert.equal(plugin.id, "cursor.provider")
  assert.equal(typeof plugin.setup, "function")
  assert.equal(typeof plugin.server, "function")

  const cache = join(fixture, "cache/opencode")
  mkdirSync(cache, { recursive: true })
  const { writeCache } = await import(pathToFileURL(join(packageRoot, "dist/models.js")).href)
  const { MODEL_CACHE_SCHEMA_VERSION } = await import(pathToFileURL(join(packageRoot, "dist/shared.js")).href)
  await writeCache(cache, {
    schemaVersion: MODEL_CACHE_SCHEMA_VERSION, fetchedAt: Date.now(),
    models: [{ id: "claude-4.5-sonnet", displayName: "Sonnet 4.5", supportsAgent: true, supportsImages: true, variants: [] }],
  })
  const hooks = new Map()
  const tools = new Map()
  const inventory = []
  const permissions = []
  const methods = []
  const registrations = new Set()
  let eventClosed = false
  const registration = (key) => {
    registrations.add(key)
    return Effect.succeed({ dispose: Effect.sync(() => registrations.delete(key)) })
  }
  const domain = (name) => new Proxy({
    hook: (key, callback, options) => {
      hooks.set(`${name}.${key}`, { callback, options })
      return registration(`${name}.${key}`)
    },
    reload: () => Effect.void,
    transform: () => registration(`${name}.transform`),
  }, { get: (target, key) => key in target ? target[key] : () => Effect.void })
  const host = Object.fromEntries([
    "agent", "aisdk", "command", "credential", "event", "generate", "integration", "mcp", "message", "model",
    "permission", "plugin", "provider", "reference", "session", "shell", "skill", "storage", "tool", "vcs", "websearch", "worktree",
  ].map((name) => [name, domain(name)]))
  host.app = { name: "opencode", version: "2.0.0", channel: "dev" }
  mkdirSync(join(fixture, "workspace"))
  host.location = { directory: join(fixture, "workspace") }
  host.options = {}
  host.experimental = { terminal: domain("terminal") }
  host.rpc = Object.assign(() => { throw new Error("unexpected RPC") }, { register: () => Effect.void })
  host.vcs.branch = domain("branch")
  host.session.instructions = { entry: domain("session.instructions.entry") }
  host.integration.connection = {
    active: () => Effect.succeed(undefined), resolve: () => Effect.succeed(undefined), status: () => Effect.void,
  }
  host.integration.transform = (callback) => {
    callback({ update: (_id, update) => update({ id: "cursor", name: "Cursor" }), method: { update: (value) => methods.push(value) } })
    return registration("integration.transform")
  }
  const publish = (callback) => callback({ add: (value) => {
    Schema.decodeUnknownSync(Provider.Info)(value.info)
    for (const model of value.models) Schema.decodeUnknownSync(Model.Info)(model)
    inventory.push(value)
  } })
  let providerTransform
  host.provider.transform = (callback) => {
    providerTransform = callback
    publish(callback)
    return registration("provider.transform")
  }
  host.provider.reload = () => Effect.sync(() => publish(providerTransform))
  host.mcp.transform = (callback) => {
    callback({ list: () => [["fixture_mcp", {}], ["explicit_code", { codemode: true }]] })
    return registration("mcp.transform")
  }
  tools.set("fixture_mcp_ping", { name: "fixture_mcp_ping", options: { namespace: "fixture_mcp" }, execute: () => Effect.void })
  tools.set("explicit_code_ping", { name: "explicit_code_ping", options: { namespace: "explicit_code" }, execute: () => Effect.void })
  host.tool.transform = (callback) => {
    callback({
      list: () => [...tools].map(([id, tool]) => ({ ...tool, id })),
      get: (id) => tools.get(id),
      add: (tool) => tools.set(tool.name, tool),
      update: (id, update) => update(tools.get(id)),
    })
    return registration("tool.transform")
  }
  host.permission.assert = (request) => Effect.sync(() => permissions.push(request))
  host.session.get = () => Effect.fail(new Error("fixture uses Location fallback"))
  host.event.subscribe = () => Stream.never.pipe(Stream.ensuring(Effect.sync(() => { eventClosed = true })))

  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* fromPromise(plugin).effect(host)
    assert(inventory.length > 0, "cached inventory was not published")
    assert.equal(inventory.at(-1).info.id, "cursor")
    const model = inventory.at(-1).models[0]
    const sdkEvent = { model, package: inventory.at(-1).info.package, options: {} }
    yield* hooks.get("aisdk.sdk").callback(sdkEvent)
    assert.equal(typeof sdkEvent.sdk.languageModel, "function")
    const languageEvent = { model, sdk: sdkEvent.sdk, options: {} }
    yield* hooks.get("aisdk.language").callback(languageEvent)
    assert.equal(languageEvent.language.specificationVersion, "v3")
    assert.equal(languageEvent.language.modelId, model.modelID)
    assert(methods.some((method) => method.method.type === "oauth" && typeof method.refresh === "function"))
    assert.equal(tools.get("fixture_mcp_ping").options.codemode, false)
    assert.notEqual(tools.get("explicit_code_ping").options.codemode, false)
    assert.deepEqual([...tools.keys()].filter((name) => ["todowrite", "todoread", "cursor_image_save"].includes(name)).sort(), ["cursor_image_save", "todoread", "todowrite"])
    const context = { sessionID: "ses_fixture", agent: "build", messageID: "msg_fixture", id: "call_fixture", progress: () => Effect.void }
    const todo = yield* tools.get("todowrite").execute({ todos: [{ content: "packed host", status: "in_progress", priority: "high" }] }, context)
    assert.equal(todo.output.todos[0].content, "packed host")
    const read = yield* tools.get("todoread").execute({}, context)
    assert.equal(read.output.todos[0].status, "in_progress")
    const other = yield* tools.get("todoread").execute({}, { ...context, sessionID: "ses_other" })
    assert.deepEqual(other.output.todos, [])
    const { stageCursorImage } = yield* Effect.promise(() => import(pathToFileURL(join(packageRoot, "dist/image-staging.js")).href))
    const projectDir = join(fixture, "artifacts")
    mkdirSync(projectDir)
    const target = join(projectDir, "assets/image.png")
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 1])
    const image_id = stageCursorImage({ path: target, projectDir, mime: "image/png", data: bytes })
    const saved = yield* tools.get("cursor_image_save").execute({ image_id }, context)
    assert.equal(saved.output.bytes, bytes.length)
    assert.deepEqual(readFileSync(target), Buffer.from(bytes))
    assert.deepEqual(permissions.map((request) => request.action), ["external_directory", "edit"])
    assert.deepEqual(permissions[1].resources, [permissions[1].metadata.filepath])
    assert.deepEqual(permissions[0].source, { type: "tool", messageID: "msg_fixture", id: "call_fixture" })
    // Hooks and tool executors above ran through the actual host Promise/Effect adapter.
    assert(hooks.has("session.model.request"))
    assert.equal(hooks.get("session.model.request").options.providerID, "cursor")
    yield* Effect.yieldNow
  })))
  assert.equal(registrations.size, 0, "plugin cleanup leaked registrations")
  assert.equal(eventClosed, true, "plugin cleanup leaked its event stream")
  console.log(JSON.stringify({ passed: true, host: execFileSync("git", ["rev-parse", "HEAD"], { cwd: hostRoot, encoding: "utf8" }).trim(), entry: "dist/plugin-opencode2.js", models: inventory.at(-1).models.length, checks: ["packed-resolution", "actual-promise-adapter", "provider-model-schemas", "sdk-language-v3", "oauth-registration", "mcp-placement", "todos-session-isolation", "native-image-permission", "cleanup"] }, null, 2))
} finally {
  rmSync(fixture, { recursive: true, force: true })
}
