# OpenCode 2 migration parity

Audit date: 2026-10-17.

## Revisions and scope

- Provider base: pushed `origin/local/recovery-on-0.8.1`, commit `9c78075` (foreign-provider compaction recovery). This includes interrupted-run recovery, six-hour reachability retry, large-tool-call waits and request-sized write drain timeouts.
- Provider work branch: `verify-opencode2-parity`.
- Fetched OpenCode `origin/dev`: `594af423e8676b8458d6ef125ddde6766afad392`.
- Packed-host verification: integration worktree at `86c7f7c84048d776ba94b94bfab782b2b0a6d776`. The plugin runtime, permission/tool/provider/model schemas, session model request, tool runtime and AI SDK source are unchanged between these host revisions. Only plugin compiler/package configuration differs in the audited paths.

`src/plugin-opencode2.ts` is the real OpenCode 2 plugin. `src/plugin-v2.ts` targets the older OpenCode 1.18 Promise API. These entrypoints remain separate.

Tests below prove protocol and host-contract behavior. Live model traffic, TUI rendering and real network-loss acceptance belong to the isolated migration candidate. A passing fixture is not a claim that a six-hour outage was reproduced.

## Existing parity

| Behavior | Implementation | Verification |
| --- | --- | --- |
| Subscription auth | PKCE browser login; key/env connection methods; separate session and API-key renewal; per-Run token resolution | `auth.test.ts`, `auth-renewal.test.ts`, `plugin-opencode2.test.ts`; packed host registers OAuth/refresh through the real adapter |
| Model inventory, variants and pricing | In-memory provider transform, account-bound source connection, cache seed, wire model id separate from display entry | `models.test.ts`, `pricing.test.ts`, `plugin-opencode2.test.ts`; packed payloads decode with real host `Provider.Info` and `Model.Info` |
| AI SDK entrypoint | `./server` export resolves to the OpenCode 2 plugin; SDK and language hooks select LanguageModelV3 | Packed real-host resolver/load and Promise adapter check |
| Native tools and MCP | Provider consumes the supplied canonical catalog. MCP servers without explicit `codemode: true` move to direct tools; explicit opt-in stays Code Mode. No MCP config rewrite | `opencode2-mcp-direct.test.ts`, `dynamic-catalog.test.ts`, `tools.test.ts`; real-adapter packed tool transform |
| Shell environment | Tool execution id correlates Cursor metadata; shell create hook injects wrapper env; wrapper-command fallback supports older hosts | `shell-timeout.test.ts`, `plugin-opencode2.test.ts` |
| Session/workspace identity | Native `x-opencode-session-id` takes precedence over shared affinity; model.request adds encoded session directory; owning agent is a request-local option | `plugin-opencode2.test.ts`, `continuation-session.test.ts`, `workspace-root-compat.test.ts` |
| Read/edit/patch | Schema/catalog-based remap; native OpenCode 2 field names; partial-read notices; correlated complete reads before targeted edits | `tools.test.ts`, `apply-patch.test.ts`, `read-cap-repro.test.ts`, `payload-truncation.test.ts` |
| Tool images | Native read bytes and MCP image result items stay on the held Run; detached media attribution and budgets survive recovery | `attached-image-write.test.ts`, `image-input.test.ts`, `generate-image.test.ts` |
| Todos | Plugin-owned direct `todowrite`/`todoread`, enabled only with `CURSOR_OPENCODE2_TODOS=1` or `true`; skip host-owned names | `todo-tools.test.ts`; packed actual host executor writes, reads and proves session isolation |
| Streaming narration | Separate reasoning/text deltas; several tool requests complete one AI SDK step; lifecycle turns cannot execute tools | `stream.test.ts`, `parallel-pump.test.ts`, `display-bridge-pump.test.ts`, `allow-tools.test.ts` |
| Context/cache | Frozen baseline per conversation, live catalog overlay, later instruction updates on the user turn, checkpoint token occupancy | `context-epoch.test.ts`, `frozen-request-context.test.ts`, `dynamic-catalog.test.ts`, `token-details.test.ts` |
| Continuation/restart | Held Runs correlate pending calls; checkpoints retain reachable blobs, workspace state and provenance; disk hydration restores state | `continuation-session.test.ts`, `conversation-persistence.test.ts`, `kv.test.ts`, `fresh-turn-drain.test.ts` |
| Interrupted/large/slow generation | Resume interrupted Runs; retain large tool-call generation while the server progresses; scale write-drain deadline by payload size | `run-interruption.test.ts`, `heartbeat-generation.test.ts`, `write-drain-timeout.test.ts` |
| Long outages and replay safety | Six-hour reachability window; cancellation remains effective; stateful or visible output prevents unsafe replay | `replay-safety.test.ts`, `run-interruption.test.ts`, `session-ping.test.ts` |
| Compaction and model changes | Foreign-provider compaction reseeds; foreign assistant provenance reseeds; Cursor-to-Cursor model change preserves conversation | `turn-provenance.test.ts`, `prompt-history.test.ts`, `conversation-id.test.ts`, `replay-safety.test.ts` |
| Subagent identity | Native session header prevents parent affinity collision; child activity renews parent pending-tool lease | `activity.test.ts`, `plugin-opencode2.test.ts`, `continuation-session.test.ts` |
| Plan/build mode | Native switchAgent after terminal Run; CreatePlan review and approval; host Plan agent is authoritative | `switch-mode.test.ts`, `create-plan.test.ts`, `plugin-opencode2.test.ts` |
| Standalone provider boundary | Native cache/data/config paths without bridges; no compatibility imports or alternate host recognition | `architecture.test.ts`, `paths.test.ts`; rebuilt published `dist/` included in scan |

## Changes in this branch

1. Image commit now uses public plugin `ctx.permission.assert`. It raises external-directory then edit checks with the native session, agent and tool-call source. A refusal preserves its original error identity, so OpenCode can terminate a declined step. Tests cover both refusal positions and confirm no output directory is created.
2. Plugin cleanup aborts the event subscription. The previous boolean only stopped it after another event arrived, leaving a quiet subscription waiting across reloads.
3. `test/packed-opencode2-host.mjs` checks the packed artifact against a dependency-installed real host. It uses the host resolver, module loader, Promise-to-Effect adapter and schema decoders. Its service fixtures avoid credentials, network requests, a live database and source changes to the host.

## Verification commands

Results on 2026-10-17: typecheck and build passed; all 1,507 tests across 73
files passed (5,303 assertions), including the rebuilt distribution architecture
scan. The packed real-host check passed all nine reported checks. The extracted
provider had only its production dependencies available.

Run finite checks through the shared heavy-job guard. Use a bounded monitor if the queue or run can exceed two minutes.

```sh
python3 ~/.claude/scripts/heavy-job.py --wait -- bun run typecheck
python3 ~/.claude/scripts/heavy-job.py --wait -- bun run build
python3 ~/.claude/scripts/heavy-job.py --wait -- bun test
bun pm pack --destination /absolute/artifact/directory
python3 ~/.claude/scripts/heavy-job.py --wait -- bun test/packed-opencode2-host.mjs \
  /absolute/dependency-installed/opencode \
  /absolute/artifact/directory/cursor-opencode-provider-0.8.1.tgz
```

The pack check creates and removes its own temporary cache/data/home/workspace. It imports only the packed provider `dist/` and exposes only production dependencies from the provider worktree. The optional OpenCode 1.x plugin SDK is absent from the extracted package's dependency path. It does not install into or restart a running host.

## Host contract gaps and candidate acceptance

- **Todo UI/persistence:** provider todos are in-memory session data. The stock host has no equivalent checklist UI/persistence contract. The migration candidate enables `CURSOR_OPENCODE2_TODOS=1`; UI/history parity needs a host-owned contract. This branch preserves the deliberate off-by-default public behavior.
- **Shell/MCP hook identity:** core and plugin streams own sessionID/cwd on real shell creation and tool hooks for actual Code Mode MCP leaf execution. The provider already correlates the host execution id and preserves the advertised tools; it cannot reconstruct a missing native leaf hook. The seam was reported directly to core and copied to the manager.
- **Native host integration:** packed conformance uses real adapter/schema code but fixture services. Manager acceptance must exercise authenticated inventory, prompts, permission UI, real tools/MCP, subagent spawning, restarts and compaction in isolated state.
- **Long-outage acceptance:** protocol tests simulate failures and timers. A live network-loss claim needs a measured isolated-host run, including cancellation and recovery without duplicate side effects.

The manager retains the worktree until integration. No version change, tag, publish, live provider replacement or V1 restart is part of this branch.
