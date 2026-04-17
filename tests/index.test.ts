import { describe, expect, test } from "bun:test"

import CheckpointPlugin from "../src/index"

type MockResult = {
  exitCode?: number
  stdout?: string
  stderr?: string
}

type Rule = {
  when: (command: string) => boolean
  result: MockResult
}

function commandFromTemplate(strings: TemplateStringsArray, values: unknown[]): string {
  let command = ""

  for (let i = 0; i < strings.length; i += 1) {
    command += strings[i]
    if (i < values.length) {
      command += String(values[i])
    }
  }

  return command.replace(/\s+/g, " ").trim()
}

function createMockShell(rules: Rule[], fallback: MockResult = { exitCode: 0, stdout: "", stderr: "" }) {
  const commands: string[] = []

  const shell = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = commandFromTemplate(strings, values)
    commands.push(command)

    return {
      quiet() {
        return this
      },
      async nothrow() {
        const matched = rules.find((rule) => rule.when(command))
        return matched?.result ?? fallback
      },
    }
  }

  return {
    shell,
    commands,
  }
}

async function createPluginContext(shell: unknown, logs: string[], directory = "/repo") {
  return CheckpointPlugin(
    {
      $: shell,
      client: {
        app: {
          log: async ({ body }: { body: { message: string } }) => {
            logs.push(body.message)
          },
        },
      },
      directory,
      project: {} as unknown,
      worktree: directory,
      experimental_workspace: {
        register: () => undefined,
      },
      serverUrl: new URL("http://localhost"),
    } as never,
    {},
  )
}

describe("opencode-checkpoints plugin", () => {
  test("session.idle creates auto checkpoint and prunes old ones", async () => {
    const rules: Rule[] = [
      {
        when: (command) => command.includes("rev-parse --git-dir"),
        result: { exitCode: 0, stdout: ".git" },
      },
      {
        when: (command) => command.includes("stash push -u -m opencode-auto-"),
        result: { exitCode: 0, stdout: "Saved working directory and index state" },
      },
      {
        when: (command) => command.includes("stash pop stash@{0}"),
        result: { exitCode: 0, stdout: "Applied stash" },
      },
      {
        when: (command) => command.includes("stash list --format=%gd:::%s"),
        result: {
          exitCode: 0,
          stdout: [
            "stash@{0}:::opencode-auto-0",
            "stash@{1}:::opencode-auto-1",
            "stash@{2}:::opencode-auto-2",
            "stash@{3}:::opencode-auto-3",
            "stash@{4}:::opencode-auto-4",
            "stash@{5}:::opencode-auto-5",
            "stash@{6}:::opencode-auto-6",
            "stash@{7}:::opencode-auto-7",
            "stash@{8}:::opencode-auto-8",
            "stash@{9}:::opencode-auto-9",
            "stash@{10}:::opencode-auto-10",
            "stash@{11}:::opencode-auto-11",
          ].join("\n"),
        },
      },
      {
        when: (command) => command.includes("stash drop stash@{11}"),
        result: { exitCode: 0, stdout: "Dropped" },
      },
      {
        when: (command) => command.includes("stash drop stash@{10}"),
        result: { exitCode: 0, stdout: "Dropped" },
      },
    ]

    const { shell, commands } = createMockShell(rules)
    const logs: string[] = []
    const hooks = await createPluginContext(shell, logs)

    await hooks["session.idle"]?.()

    expect(commands.some((command) => command.includes("stash push -u -m opencode-auto-"))).toBe(true)
    expect(commands.some((command) => command.includes("stash pop stash@{0}"))).toBe(true)
    expect(commands.some((command) => command.includes("stash drop stash@{11}"))).toBe(true)
    expect(commands.some((command) => command.includes("stash drop stash@{10}"))).toBe(true)
    expect(logs).toContain("✓ Checkpoint auto guardado")
  })

  test("tool.execute.before creates checkpoint for destructive bash command", async () => {
    const { shell, commands } = createMockShell([
      {
        when: (command) => command.includes("rev-parse --git-dir"),
        result: { exitCode: 0, stdout: ".git" },
      },
      {
        when: (command) => command.includes("stash push -u -m opencode-before-bash-"),
        result: { exitCode: 0, stdout: "Saved" },
      },
      {
        when: (command) => command.includes("stash pop stash@{0}"),
        result: { exitCode: 0, stdout: "Applied" },
      },
    ])

    const logs: string[] = []
    const hooks = await createPluginContext(shell, logs)

    await hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "s", callID: "c" }, {
      args: { command: "DROP TABLE users" },
    })

    expect(commands.some((command) => command.includes("stash push -u -m opencode-before-bash-"))).toBe(
      true,
    )
    expect(logs.some((message) => message.includes("Checkpoint guardado antes de bash"))).toBe(true)
  })

  test("tool.execute.before ignores non-destructive bash command", async () => {
    const { shell, commands } = createMockShell([])
    const logs: string[] = []
    const hooks = await createPluginContext(shell, logs)

    await hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "s", callID: "c" }, {
      args: { command: "echo hello" },
    })

    expect(commands.length).toBe(0)
    expect(logs.length).toBe(0)
  })

  test("chat.message /checkpoint clears message and returns handled", async () => {
    const { shell, commands } = createMockShell([
      {
        when: (command) => command.includes("rev-parse --git-dir"),
        result: { exitCode: 0, stdout: ".git" },
      },
      {
        when: (command) => command.includes("stash push -u -m opencode-manual-demo"),
        result: { exitCode: 0, stdout: "Saved" },
      },
      {
        when: (command) => command.includes("stash pop stash@{0}"),
        result: { exitCode: 0, stdout: "Applied" },
      },
    ])

    const logs: string[] = []
    const hooks = await createPluginContext(shell, logs)
    const output = { message: { content: "/checkpoint demo" }, parts: [] as unknown[] }

    const result = await (hooks["chat.message"] as ((input: unknown, output: unknown) => Promise<unknown>))(
      { sessionID: "s" },
      output,
    )

    expect(output.message.content).toBe("")
    expect(result).toEqual({ handled: true })
    expect(commands.some((command) => command.includes("stash push -u -m opencode-manual-demo"))).toBe(
      true,
    )
    expect(logs.some((message) => message.includes("Checkpoint manual creado"))).toBe(true)
  })

  test("chat.message /restore uses numeric stash index interpolation", async () => {
    const { shell, commands } = createMockShell([
      {
        when: (command) => command.includes("rev-parse --git-dir"),
        result: { exitCode: 0, stdout: ".git" },
      },
      {
        when: (command) => command.includes("stash list --format=%gd:::%s"),
        result: {
          exitCode: 0,
          stdout: [
            "stash@{0}:::opencode-manual-one",
            "stash@{5}:::opencode-manual-two",
          ].join("\n"),
        },
      },
      {
        when: (command) => command.includes("stash pop stash@{5}"),
        result: { exitCode: 0, stdout: "Applied" },
      },
    ])

    const logs: string[] = []
    const hooks = await createPluginContext(shell, logs)
    const output = { message: { content: "/restore 2" }, parts: [] as unknown[] }

    const result = await (hooks["chat.message"] as ((input: unknown, output: unknown) => Promise<unknown>))(
      { sessionID: "s" },
      output,
    )

    expect(result).toEqual({ handled: true })
    expect(commands.some((command) => command.includes("stash pop stash@{5}"))).toBe(true)
    expect(logs).toContain("↩️ Restaurado checkpoint 2")
  })
})
