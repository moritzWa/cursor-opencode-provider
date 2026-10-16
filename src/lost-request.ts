import { createHash } from "node:crypto"
import { processShared } from "./process-shared.js"

export type LostRequest = {
  conversationId: string
  checkpointKey: string
  text: string
}

const MAX_RECORDS = 1_024

const records = () => processShared("lost-request.v1", () => new Map<string, LostRequest>())

export function checkpointKey(bytes: Uint8Array | undefined): string {
  if (!bytes?.length) return "none"
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Prepend a user message whose Run never received a newer checkpoint.
 * A history rebuild already contains it, so that path drops the record.
 * An exact retry of the same text is left as-is. Live text the record already
 * carries as one of its parts (a host retry that sends the same note on every
 * attempt) sends the record unchanged, so failed retries do not pile up.
 */
export function carryLostRequest(input: {
  sessionKey: string
  conversationId: string
  checkpoint: Uint8Array | undefined
  text: string
  rebuildFromHistory: boolean
}): string {
  const map = records()
  const record = map.get(input.sessionKey)
  if (!record) return input.text
  const key = checkpointKey(input.checkpoint)
  if (
    input.rebuildFromHistory
    || record.conversationId !== input.conversationId
    || record.checkpointKey !== key
  ) {
    map.delete(input.sessionKey)
    return input.text
  }
  if (input.text === record.text || input.text.startsWith(`${record.text}\n\n`)) return input.text
  if (carriesPart(record.text, input.text)) return record.text
  map.delete(input.sessionKey)
  return `${record.text}\n\n${input.text}`
}

/** `part` is one whole `\n\n`-separated piece of `text`, as `carryLostRequest` joins them. */
function carriesPart(text: string, part: string): boolean {
  return text.startsWith(`${part}\n\n`)
    || text.endsWith(`\n\n${part}`)
    || text.includes(`\n\n${part}\n\n`)
}

export function rememberLostRequest(input: {
  sessionKey: string
  conversationId: string
  checkpoint: Uint8Array | undefined
  text: string
}): void {
  if (!input.sessionKey || !input.text || input.text === ".") return
  setRecord(input.sessionKey, {
    conversationId: input.conversationId,
    checkpointKey: checkpointKey(input.checkpoint),
    text: input.text,
  })
}

/** A session that never sends another turn must not keep its record forever. */
function setRecord(sessionKey: string, record: LostRequest): void {
  const map = records()
  map.delete(sessionKey)
  map.set(sessionKey, record)
  while (map.size > MAX_RECORDS) {
    const oldest = map.keys().next().value as string | undefined
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** A checkpoint other than the one this turn was sent on means Cursor kept the turn. */
export function noteCheckpoint(sessionKey: string | undefined, bytes: Uint8Array): void {
  if (!sessionKey) return
  const map = records()
  const record = map.get(sessionKey)
  if (!record) return
  if (checkpointKey(bytes) !== record.checkpointKey) map.delete(sessionKey)
}

export function hasLostRequest(sessionKey: string | undefined): boolean {
  return !!sessionKey && records().has(sessionKey)
}

export function dropLostRequest(sessionKey: string | undefined): void {
  if (sessionKey) records().delete(sessionKey)
}

export function serializeLostRequest(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined
  const record = records().get(sessionKey)
  return record ? JSON.stringify(record) : undefined
}

export function restoreLostRequest(sessionKey: string, raw: string | undefined): void {
  if (!raw || records().has(sessionKey)) return
  let parsed: Partial<LostRequest>
  try {
    parsed = JSON.parse(raw) as Partial<LostRequest>
  } catch {
    return
  }
  if (
    typeof parsed.conversationId !== "string"
    || typeof parsed.checkpointKey !== "string"
    || typeof parsed.text !== "string"
    || parsed.text.length === 0
  ) return
  setRecord(sessionKey, {
    conversationId: parsed.conversationId,
    checkpointKey: parsed.checkpointKey,
    text: parsed.text,
  })
}

export function resetLostRequestsForTests(): void {
  records().clear()
}
