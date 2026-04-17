import type { Plugin } from "@opencode-ai/plugin"

type BunShellCommand = {
  quiet(): BunShellCommand
  nothrow(): Promise<unknown>
}

type BunShell = (strings: TemplateStringsArray, ...values: unknown[]) => BunShellCommand

type ShellResult = {
  exitCode?: number
  stdout?: unknown
  stderr?: unknown
}

type CheckpointEntry = {
  index: number
  stashRef: string
  message: string
}

const NON_GIT_REPO_MESSAGE = "⚠️ Checkpoint omitido: no es un repo git"
let notifyInfo: (message: string) => Promise<void> = async () => undefined

function toOutputText(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value)
  }

  if (value === undefined || value === null) {
    return ""
  }

  return String(value)
}

function toShellResult(result: unknown): ShellResult {
  if (!result || typeof result !== "object") {
    return {}
  }

  return result as ShellResult
}

function getExitCode(result: unknown): number {
  const typed = toShellResult(result)
  return typeof typed.exitCode === "number" ? typed.exitCode : 1
}

function getStdErr(result: unknown): string {
  const typed = toShellResult(result)
  return toOutputText(typed.stderr).trim()
}

function getStdOut(result: unknown): string {
  const typed = toShellResult(result)
  return toOutputText(typed.stdout).trim()
}

function nowToken(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function normalizeLabel(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")

  return normalized || nowToken()
}

function parseStashLine(line: string): { stashRef: string; message: string } | null {
  const separator = ":::"
  const index = line.indexOf(separator)

  if (index < 0) {
    return null
  }

  const stashRef = line.slice(0, index).trim()
  const message = line.slice(index + separator.length).trim()

  if (!stashRef || !message) {
    return null
  }

  return { stashRef, message }
}

function getStashNumber(stashRef: string): number {
  const match = /stash@\{(\d+)\}/.exec(stashRef)
  if (!match) {
    return -1
  }

  const parsed = Number.parseInt(match[1], 10)
  return Number.isNaN(parsed) ? -1 : parsed
}

function getToolName(tool: unknown): string {
  if (typeof tool === "string") {
    return tool
  }

  if (tool && typeof tool === "object") {
    const maybeName = (tool as { name?: unknown }).name
    if (typeof maybeName === "string") {
      return maybeName
    }
  }

  return ""
}

function getBashCommandArg(args: unknown): string {
  if (!args || typeof args !== "object") {
    return ""
  }

  const commandValue = (args as { command?: unknown }).command
  return typeof commandValue === "string" ? commandValue : ""
}

function isDestructiveCommand(command: string): boolean {
  const text = command.toLowerCase()

  return ["rm ", "drop ", "truncate", "git reset --hard", "git clean"].some((pattern) =>
    text.includes(pattern),
  )
}

async function isGitRepo($: BunShell, directory: string): Promise<boolean> {
  try {
    const probe = await $`git -C ${directory} rev-parse --git-dir`.quiet().nothrow()

    if (getExitCode(probe) !== 0) {
      await notifyInfo(NON_GIT_REPO_MESSAGE)
      return false
    }

    return true
  } catch (error) {
    console.error("[opencode-checkpoints] git repo check failed", error)
    await notifyInfo(NON_GIT_REPO_MESSAGE)
    return false
  }
}

async function createCheckpoint($: BunShell, directory: string, label: string): Promise<string> {
  try {
    if (!(await isGitRepo($, directory))) {
      return ""
    }

    // Snapshot: push + immediate pop so the working tree stays the same
    const push = await $`git -C ${directory} stash push -u -m ${label}`.quiet().nothrow()

    if (getExitCode(push) !== 0) {
      console.error("[opencode-checkpoints] git stash push failed", getStdErr(push))
      return ""
    }

    const pushText = `${getStdOut(push)}\n${getStdErr(push)}`
    if (/no local changes to save/i.test(pushText)) {
      return ""
    }

    const pop = await $`git -C ${directory} stash pop stash@{0}`.quiet().nothrow()
    if (getExitCode(pop) !== 0) {
      console.error("[opencode-checkpoints] git stash pop failed", getStdErr(pop))
      return ""
    }

    return label
  } catch (error) {
    console.error("[opencode-checkpoints] createCheckpoint failed", error)
    return ""
  }
}

async function listCheckpoints($: BunShell, directory: string): Promise<Array<CheckpointEntry>> {
  try {
    if (!(await isGitRepo($, directory))) {
      return []
    }

    const listed = await $`git -C ${directory} stash list --format=%gd:::%s`.quiet().nothrow()
    if (getExitCode(listed) !== 0) {
      console.error("[opencode-checkpoints] git stash list failed", getStdErr(listed))
      return []
    }

    const output = getStdOut(listed)
    if (!output) {
      return []
    }

    const checkpoints: Array<CheckpointEntry> = []
    const lines = output.split(/\r?\n/)

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }

      const parsed = parseStashLine(trimmed)
      if (!parsed) {
        continue
      }

      if (!parsed.message.startsWith("opencode-")) {
        continue
      }

      checkpoints.push({
        index: checkpoints.length + 1,
        stashRef: parsed.stashRef,
        message: parsed.message,
      })
    }

    return checkpoints
  } catch (error) {
    console.error("[opencode-checkpoints] listCheckpoints failed", error)
    return []
  }
}

async function restoreCheckpoint(
  $: BunShell,
  directory: string,
  n: number,
  hard?: boolean,
): Promise<void> {
  try {
    if (!(await isGitRepo($, directory))) {
      return
    }

    if (!Number.isInteger(n) || n < 1) {
      return
    }

    const checkpoints = await listCheckpoints($, directory)
    const target = checkpoints.find((entry) => entry.index === n)

    if (!target) {
      return
    }

    const stashNumber = getStashNumber(target.stashRef)
    if (stashNumber < 0) {
      return
    }

    const restore = hard
      ? await $`git -C ${directory} stash apply stash@{${stashNumber}}`.quiet().nothrow()
      : await $`git -C ${directory} stash pop stash@{${stashNumber}}`.quiet().nothrow()

    if (getExitCode(restore) !== 0) {
      console.error("[opencode-checkpoints] restore failed", getStdErr(restore))
    }
  } catch (error) {
    console.error("[opencode-checkpoints] restoreCheckpoint failed", error)
  }
}

async function pruneOldCheckpoints(
  $: BunShell,
  directory: string,
  prefix: string,
  maxKeep: number,
): Promise<void> {
  try {
    if (!(await isGitRepo($, directory))) {
      return
    }

    if (!Number.isInteger(maxKeep) || maxKeep < 1) {
      return
    }

    const checkpoints = await listCheckpoints($, directory)
    const matching = checkpoints.filter((entry) => entry.message.startsWith(prefix))

    if (matching.length <= maxKeep) {
      return
    }

    const toRemove = matching.slice(maxKeep)
    const orderedRefs = toRemove
      .map((entry) => entry.stashRef)
      .sort((a, b) => getStashNumber(b) - getStashNumber(a))

    for (const stashRef of orderedRefs) {
      const dropResult = await $`git -C ${directory} stash drop ${stashRef}`.quiet().nothrow()
      if (getExitCode(dropResult) !== 0) {
        console.error("[opencode-checkpoints] prune drop failed", getStdErr(dropResult))
      }
    }
  } catch (error) {
    console.error("[opencode-checkpoints] pruneOldCheckpoints failed", error)
  }
}

const CheckpointPlugin: Plugin = async ({ $, client, directory }) => {
  const shell = $ as BunShell

  notifyInfo = async (message: string): Promise<void> => {
    try {
      await client.app.log({
        body: {
          service: "opencode-checkpoints",
          level: "info",
          message,
        },
      })
    } catch (error) {
      console.error("[opencode-checkpoints] log notification failed", error)
    }
  }

  return {
    "session.idle": async (): Promise<void> => {
      try {
        const id = await createCheckpoint(shell, directory, `opencode-auto-${nowToken()}`)
        if (id) {
          await notifyInfo("✓ Checkpoint auto guardado")
          await pruneOldCheckpoints(shell, directory, "opencode-auto-", 10)
        }
      } catch (error) {
        console.error("[opencode-checkpoints] session.idle handler failed", error)
      }
    },

    "tool.execute.before": async (
      { tool }: { tool?: unknown },
      { args }: { args?: Record<string, unknown> },
    ): Promise<void> => {
      try {
        const toolName = getToolName(tool)
        const normalizedTool = toolName.toLowerCase()

        let shouldCreate = normalizedTool === "edit" || normalizedTool === "write"

        if (!shouldCreate && normalizedTool === "bash") {
          const command = getBashCommandArg(args)
          shouldCreate = isDestructiveCommand(command)
        }

        if (!shouldCreate) {
          return
        }

        const checkpointToolName = normalizeLabel(toolName || "tool")
        const label = `opencode-before-${checkpointToolName}-${nowToken()}`
        const id = await createCheckpoint(shell, directory, label)

        if (id) {
          await notifyInfo(`⚡ Checkpoint guardado antes de ${toolName || "tool"}`)
        }
      } catch (error) {
        console.error("[opencode-checkpoints] tool.execute.before handler failed", error)
      }
    },

    "chat.message": async (_: unknown, output: unknown): Promise<void> => {
      try {
        const message =
          output && typeof output === "object"
            ? (output as { message?: { content?: string } }).message
            : undefined

        const content = typeof message?.content === "string" ? message.content.trim() : ""
        if (!content.startsWith("/")) {
          return
        }

        const space = content.indexOf(" ")
        const command = (space === -1 ? content : content.slice(0, space)).toLowerCase()
        const rest = space === -1 ? "" : content.slice(space + 1).trim()

        const knownCommands = new Set(["/checkpoint", "/checkpoints", "/restore", "/restore-hard"])
        if (!knownCommands.has(command)) {
          return
        }

        if (message) {
          message.content = ""
        }

        if (command === "/checkpoint") {
          const suffix = rest ? normalizeLabel(rest) : nowToken()
          const checkpointId = await createCheckpoint(shell, directory, `opencode-manual-${suffix}`)
          if (checkpointId) {
            await notifyInfo(`📌 Checkpoint manual creado: ${checkpointId}`)
          }
          return { handled: true } as unknown as void
        }

        if (command === "/checkpoints") {
          const checkpoints = await listCheckpoints(shell, directory)

          if (checkpoints.length === 0) {
            await notifyInfo("No hay checkpoints disponibles")
            return { handled: true } as unknown as void
          }

          const lines = checkpoints.map(
            (entry) => `${entry.index}. ${entry.message} (${entry.stashRef})`,
          )

          await notifyInfo(["Checkpoints disponibles:", ...lines].join("\n"))
          return { handled: true } as unknown as void
        }

        if (command === "/restore" || command === "/restore-hard") {
          const requested = Number.parseInt(rest, 10)
          if (!Number.isInteger(requested) || requested < 1) {
            await notifyInfo(
              command === "/restore"
                ? "Uso: /restore {n}"
                : "Uso: /restore-hard {n}",
            )
            return { handled: true } as unknown as void
          }

          const checkpoints = await listCheckpoints(shell, directory)
          const target = checkpoints.find((entry) => entry.index === requested)
          if (!target) {
            await notifyInfo(`⚠️ Checkpoint ${requested} no existe`)
            return { handled: true } as unknown as void
          }

          const hard = command === "/restore-hard"
          await restoreCheckpoint(shell, directory, requested, hard)

          if (hard) {
            await notifyInfo(`↩️ Aplicado checkpoint ${requested} (stash conservado)`)
          } else {
            await notifyInfo(`↩️ Restaurado checkpoint ${requested}`)
          }

          return { handled: true } as unknown as void
        }
      } catch (error) {
        console.error("[opencode-checkpoints] chat.message handler failed", error)
      }

      return { handled: true } as unknown as void
    },
  }
}

export default CheckpointPlugin
