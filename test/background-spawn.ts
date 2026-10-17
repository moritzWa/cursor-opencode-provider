import fs from "node:fs"
import { BACKGROUND_SHELL_MARKER } from "../src/shell-timeout.js"

/**
 * Stop a detached background spawn a test ran for real and remove the log
 * `buildBackgroundShellCommand` created for it, as named by its marker line.
 */
export function reapBackgroundSpawn(stdout: string): void {
  const match = new RegExp(`${BACKGROUND_SHELL_MARKER}(\\d+):(?:\\d+:)?([^\\r\\n]+)`).exec(stdout)
  if (!match) throw new Error(`no background spawn marker in: ${stdout}`)
  try { process.kill(Number(match[1]), "SIGKILL") } catch { /* already exited */ }
  fs.rmSync(match[2]!, { force: true })
}
