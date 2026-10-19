/**
 * Session rules that still deny edits after an agent switch.
 *
 * OpenCode evaluates session rules after the agent catalog; the last matching
 * rule wins. A plan-file allow does not lift a final `edit` deny on `*`, so
 * approving a plan cannot mean implementation is now permitted.
 */

/** Shared refusal clause for a mutation the session or this turn still forbids. */
export const SHELL_NOT_FOR_FILE_WRITES = "Do not create or change files through the shell."

const FILE_MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "patch"])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** OpenCode wildcard match: `*` and `?` in the rule, anchored to the whole input. */
function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern.replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized)
}

/**
 * True when the last session rule whose action matches `edit` and whose
 * resource is `*` has effect `deny`. A later allow on only the plan path does
 * not count. A later `edit` `*` allow does.
 */
export function sessionRulesDenyEdits(permissions: unknown): boolean {
  if (!Array.isArray(permissions)) return false
  let denied = false
  for (const rule of permissions) {
    const record = asRecord(rule)
    if (!record) continue
    // Native 1.x uses permission/pattern/action; 2.0 uses action/resource/effect.
    const classic = typeof record.permission === "string"
    const action = classic ? record.permission : record.action
    const resource = classic ? record.pattern : record.resource
    const effect = classic ? record.action : record.effect
    if (resource !== "*") continue
    if (effect !== "allow" && effect !== "deny" && effect !== "ask") continue
    if (typeof action !== "string") continue
    if (!wildcardMatch("edit", action)) continue
    denied = effect === "deny"
  }
  return denied
}

/** Session payload from either entrypoint: a bare info object or `{ data }`. */
export function permissionsFromSession(session: unknown): unknown {
  const record = asRecord(session)
  const info = asRecord(record?.data) ?? record
  return info?.permissions ?? info?.permission
}

/**
 * Read current permission evidence before a request can approve implementation.
 * Retry once for a transient host lookup failure. A failed read is not an empty
 * ruleset; classic SDK error responses may resolve instead of throwing.
 */
export async function loadSessionForPermissions<T>(getSession: () => Promise<T>): Promise<T> {
  const read = async (): Promise<T> => {
    const session = await getSession()
    const response = asRecord(session)
    if (!response || response.error != null) {
      throw new Error("Could not read OpenCode session permissions")
    }
    return session
  }
  try {
    return await read()
  } catch {
    return read()
  }
}

/** Edit guidance Cursor last received per conversation: `true` deny, `false` no deny. */
const editGuidanceByConversation = new Map<string, boolean>()

/**
 * The session-edit state to state in this request, or `undefined` for none.
 * A deny is stated every time. The no-deny note only supersedes a deny Cursor
 * may hold: one this process sent, or, when this process has sent nothing to
 * the conversation, one inside a checkpoint or carried notes from before.
 */
export function sessionEditsGuidance(
  conversationId: string,
  denied: boolean | undefined,
  options: { carriesEarlierState: boolean },
): boolean | undefined {
  if (denied === undefined) return undefined
  const previous = editGuidanceByConversation.get(conversationId)
  editGuidanceByConversation.set(conversationId, denied)
  if (denied) return true
  if (previous === false || (previous === undefined && !options.carriesEarlierState)) return undefined
  return false
}

export function resetSessionEditsGuidanceForTests(): void {
  editGuidanceByConversation.clear()
}

export function notPermittedThisTurnReason(toolName: string, permittedToolNames: Iterable<string>): string {
  const permitted = [...permittedToolNames].sort().join(", ")
  const shell = FILE_MUTATION_TOOLS.has(toolName) ? ` ${SHELL_NOT_FOR_FILE_WRITES}` : ""
  return `OpenCode tool '${toolName}' is not permitted for the current agent this turn. `
    + `Permitted tools: ${permitted || "none"}. Continue using only permitted tools; do not retry `
    + `'${toolName}'.${shell}`
}
