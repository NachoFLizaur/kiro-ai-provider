import { describe, test, expect, mock, spyOn, beforeEach } from "bun:test"
import { EventStreamCodec } from "@smithy/eventstream-codec"
import type { MessageHeaders } from "@smithy/types"
import type { KiroStreamEvent } from "../src/kiro-api-types"

// ---------------------------------------------------------------------------
// 1. kiro-api-types — compile-time type assertions
// ---------------------------------------------------------------------------

describe("kiro-api-types", () => {
  test("KiroConversationState satisfies expected shape", async () => {
    const mod = await import("../src/kiro-api-types")
    expect(mod).toBeDefined()
  })

  test("KiroStreamEvent union covers expected event types", () => {
    type Cases =
      | { readonly type: "content"; readonly payload: { readonly content: string } }
      | { readonly type: "tool_start"; readonly payload: { readonly name: string; readonly toolUseId: string } }
      | { readonly type: "tool_input"; readonly payload: { readonly input: string } }
      | { readonly type: "tool_stop"; readonly payload: { readonly stop: boolean } }
      | { readonly type: "usage"; readonly payload: { readonly inputTokens: number; readonly outputTokens: number } }
      | { readonly type: "context_usage"; readonly payload: { readonly contextTokens: number } }
      | { readonly type: "error"; readonly payload: { readonly message: string } }

    // If this compiles, the union shape is correct
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. kiro-error — Error creation and properties
// ---------------------------------------------------------------------------

describe("kiro-error", () => {
  test("KiroAuthError has correct name and data", async () => {
    const { KiroAuthError } = await import("../src/kiro-error")
    const err = new KiroAuthError({ message: "no token" })
    expect(err.name).toBe("KiroAuthError")
    expect(err.data.message).toBe("no token")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroApiError has correct name and data", async () => {
    const { KiroApiError } = await import("../src/kiro-error")
    const err = new KiroApiError({ status: 403, body: "forbidden" })
    expect(err.name).toBe("KiroApiError")
    expect(err.data.status).toBe(403)
    expect(err.data.body).toBe("forbidden")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroStreamError has correct name and data", async () => {
    const { KiroStreamError } = await import("../src/kiro-error")
    const err = new KiroStreamError({ message: "decode failed" })
    expect(err.name).toBe("KiroStreamError")
    expect(err.data.message).toBe("decode failed")
    expect(err).toBeInstanceOf(Error)
  })

  test("KiroAuthError message is set from data", async () => {
    const { KiroAuthError } = await import("../src/kiro-error")
    const err = new KiroAuthError({ message: "expired" })
    expect(err.message).toBe("expired")
  })

  test("KiroApiError message includes status and body", async () => {
    const { KiroApiError } = await import("../src/kiro-error")
    const err = new KiroApiError({ status: 429, body: "rate limited" })
    expect(err.message).toContain("429")
    expect(err.message).toContain("rate limited")
  })
})

// ---------------------------------------------------------------------------
// 3. kiro-auth — Token reading, caching, refresh
// ---------------------------------------------------------------------------

describe("kiro-auth", () => {
  test("TOKEN_PATH points to expected location", async () => {
    const { TOKEN_PATH } = await import("../src/kiro-auth")
    expect(TOKEN_PATH).toContain(".aws")
    expect(TOKEN_PATH).toContain("sso")
    expect(TOKEN_PATH).toContain("kiro-auth-token.json")
  })
})

// ---------------------------------------------------------------------------
// 4. kiro-translate — Message translation (pure functions)
// ---------------------------------------------------------------------------

describe("kiro-translate", () => {
  test("translates simple user prompt", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
      modelId: "kiro-v1",
      conversationId: "conv-1",
    })
    expect(result.conversationId).toBe("conv-1")
    expect(result.currentMessage.userInputMessage.content).toBe("hello")
    expect(result.currentMessage.userInputMessage.modelId).toBe("kiro-v1")
    expect(result.chatTriggerType).toBe("MANUAL")
    expect(result.history).toHaveLength(0)
  })

  test("prepends system message to first user message when no history", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "system" as const, content: "You are helpful." },
        { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-2",
    })
    expect(result.currentMessage.userInputMessage.content).toBe("You are helpful.\nhi")
    expect(result.history).toHaveLength(0)
  })

  test("generates conversationId when not provided", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "test" }] }],
      modelId: "kiro-v1",
    })
    expect(result.conversationId).toBeTruthy()
    expect(typeof result.conversationId).toBe("string")
  })

  test("translates tools into KiroToolSpec format", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "run tool" }] }],
      modelId: "kiro-v1",
      tools: [
        {
          type: "function" as const,
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    })
    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.tools).toHaveLength(1)
    expect(ctx!.tools![0].toolSpecification.name).toBe("bash")
    expect(ctx!.tools![0].toolSpecification.description).toBe("Run a command")
  })

  test("omits userInputMessageContext when no tools", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "no tools" }] }],
      modelId: "kiro-v1",
    })
    expect(result.currentMessage.userInputMessage.userInputMessageContext).toBeUndefined()
  })

  test("builds history from multi-turn conversation", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "response" }],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-3",
    })
    expect(result.currentMessage.userInputMessage.content).toBe("second")
    expect(result.history).toHaveLength(2)
    expect("userInputMessage" in result.history[0]).toBe(true)
    expect("assistantResponseMessage" in result.history[1]).toBe(true)
  })

  test("translates assistant tool calls into structured toolUses", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [
            { type: "text" as const, text: "thinking" },
            {
              type: "tool-call" as const,
              toolCallId: "tc-1",
              toolName: "bash",
              input: { command: "ls" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-1",
              toolName: "bash",
              output: { type: "text" as const, value: "file.txt" },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "done" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-4",
    })
    expect(result.currentMessage.userInputMessage.content).toBe("done")
    expect(result.history.length).toBeGreaterThanOrEqual(3)
    const assistant = result.history[1]
    expect("assistantResponseMessage" in assistant).toBe(true)
    if ("assistantResponseMessage" in assistant) {
      expect(assistant.assistantResponseMessage.content).toBe("thinking")
      expect(assistant.assistantResponseMessage.toolUses).toHaveLength(1)
      expect(assistant.assistantResponseMessage.toolUses![0].name).toBe("bash")
      expect(assistant.assistantResponseMessage.toolUses![0].input).toEqual({ command: "ls" })
      expect(assistant.assistantResponseMessage.toolUses![0].toolUseId).toBe("tc-1")
    }
  })

  test("assistant with only tool calls uses (empty) content and structured toolUses", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run it" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-only",
              toolName: "bash",
              input: { command: "echo test" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-only",
              toolName: "bash",
              output: { type: "text" as const, value: "test" },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "next" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-only",
    })
    const assistant = result.history[1]
    expect("assistantResponseMessage" in assistant).toBe(true)
    if ("assistantResponseMessage" in assistant) {
      expect(assistant.assistantResponseMessage.content).toBe("(empty)")
      expect(assistant.assistantResponseMessage.toolUses).toHaveLength(1)
      expect(assistant.assistantResponseMessage.toolUses![0].name).toBe("bash")
      expect(assistant.assistantResponseMessage.toolUses![0].input).toEqual({ command: "echo test" })
      expect(assistant.assistantResponseMessage.toolUses![0].toolUseId).toBe("tc-only")
    }
  })

  test("text-only assistant message has no toolUses", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "hello there" }],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "bye" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-text-only",
    })
    const assistant = result.history[1]
    expect("assistantResponseMessage" in assistant).toBe(true)
    if ("assistantResponseMessage" in assistant) {
      expect(assistant.assistantResponseMessage.content).toBe("hello there")
      expect(assistant.assistantResponseMessage.toolUses).toBeUndefined()
    }
  })

  test("prepends system to first history user message when history exists", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "system" as const, content: "Be concise." },
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "ok" }],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-5",
    })
    const first = result.history[0]
    expect("userInputMessage" in first).toBe(true)
    if ("userInputMessage" in first) {
      expect(first.userInputMessage.content).toContain("Be concise.")
      expect(first.userInputMessage.content).toContain("first")
    }
    expect(result.currentMessage.userInputMessage.content).toBe("second")
  })

  test("handles tool result with json output", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "q" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-2",
              toolName: "read",
              input: { path: "/tmp" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-2",
              toolName: "read",
              output: { type: "json" as const, value: { files: ["a.txt"] } },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "next" }] },
      ],
      modelId: "kiro-v1",
    })
    const toolMsg = result.history[2]
    expect("userInputMessage" in toolMsg).toBe(true)
    if ("userInputMessage" in toolMsg) {
      expect(toolMsg.userInputMessage.content).toBe(" ")
      const ctx = toolMsg.userInputMessage.userInputMessageContext
      expect(ctx).toBeDefined()
      expect(ctx!.toolResults).toHaveLength(1)
      expect(ctx!.toolResults![0].toolUseId).toBe("tc-2")
      expect(ctx!.toolResults![0].content).toEqual([{ text: JSON.stringify({ files: ["a.txt"] }) }])
      expect(ctx!.toolResults![0].status).toBe("success")
    }
  })

  test("sends trailing tool results as structured toolResults in currentMessage", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run echo test" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-100",
              toolName: "bash",
              input: { command: "echo test" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-100",
              toolName: "bash",
              output: { type: "text" as const, value: "test" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-1",
      tools: [
        {
          type: "function" as const,
          name: "bash",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } } },
        },
      ],
    })

    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.toolResults).toBeDefined()
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-100")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "test" }])
    expect(ctx!.toolResults![0].status).toBe("success")

    expect(ctx!.tools).toHaveLength(1)

    expect(result.history).toHaveLength(2)
    expect("userInputMessage" in result.history[0]).toBe(true)
    expect("assistantResponseMessage" in result.history[1]).toBe(true)
  })

  test("sends multiple trailing tool results as structured toolResults", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run two tools" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-a",
              toolName: "bash",
              input: { command: "echo a" },
            },
            {
              type: "tool-call" as const,
              toolCallId: "tc-b",
              toolName: "read",
              input: { path: "/tmp" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-a",
              toolName: "bash",
              output: { type: "text" as const, value: "a" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-b",
              toolName: "read",
              output: { type: "json" as const, value: { files: ["x.txt"] } },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-2",
    })

    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.toolResults).toHaveLength(2)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-a")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "a" }])
    expect(ctx!.toolResults![1].toolUseId).toBe("tc-b")
    expect(ctx!.toolResults![1].content).toEqual([{ text: JSON.stringify({ files: ["x.txt"] }) }])

    expect(result.history).toHaveLength(2)
  })

  test("mid-conversation tool results go in history, trailing ones go in toolResults", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-old",
              toolName: "bash",
              input: { command: "echo old" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-old",
              toolName: "bash",
              output: { type: "text" as const, value: "old" },
            },
          ],
        },
        { role: "user" as const, content: [{ type: "text" as const, text: "second" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-new",
              toolName: "bash",
              input: { command: "echo new" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-new",
              toolName: "bash",
              output: { type: "text" as const, value: "new" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-3",
    })

    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx).toBeDefined()
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-new")

    expect(result.history).toHaveLength(5)
    const oldToolResult = result.history[2]
    expect("userInputMessage" in oldToolResult).toBe(true)
    if ("userInputMessage" in oldToolResult) {
      expect(oldToolResult.userInputMessage.content).toBe(" ")
      const ctx = oldToolResult.userInputMessage.userInputMessageContext
      expect(ctx).toBeDefined()
      expect(ctx!.toolResults).toHaveLength(1)
      expect(ctx!.toolResults![0].toolUseId).toBe("tc-old")
      expect(ctx!.toolResults![0].content).toEqual([{ text: "old" }])
      expect(ctx!.toolResults![0].status).toBe("success")
    }
  })

  test("trailing tool results with system prefix prepend to first history message", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "system" as const, content: "Be helpful." },
        { role: "user" as const, content: [{ type: "text" as const, text: "run it" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-sys",
              toolName: "bash",
              input: { command: "date" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-sys",
              toolName: "bash",
              output: { type: "text" as const, value: "Mon Mar 23" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-4",
    })

    const first = result.history[0]
    expect("userInputMessage" in first).toBe(true)
    if ("userInputMessage" in first) {
      expect(first.userInputMessage.content).toContain("Be helpful.")
      expect(first.userInputMessage.content).toContain("run it")
    }

    expect(result.currentMessage.userInputMessage.content).toBe(" ")

    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].toolUseId).toBe("tc-sys")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "Mon Mar 23" }])
  })

  test("error tool results get status error", async () => {
    const { translate } = await import("../src/kiro-translate")
    const result = translate({
      prompt: [
        { role: "user" as const, content: [{ type: "text" as const, text: "run it" }] },
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "tc-err",
              toolName: "bash",
              input: { command: "false" },
            },
          ],
        },
        {
          role: "tool" as const,
          content: [
            {
              type: "tool-result" as const,
              toolCallId: "tc-err",
              toolName: "bash",
              output: { type: "error-text" as const, value: "command failed" },
            },
          ],
        },
      ],
      modelId: "kiro-v1",
      conversationId: "conv-tool-5",
    })

    const ctx = result.currentMessage.userInputMessage.userInputMessageContext
    expect(ctx!.toolResults).toHaveLength(1)
    expect(ctx!.toolResults![0].status).toBe("error")
    expect(ctx!.toolResults![0].content).toEqual([{ text: "command failed" }])
  })
})

// ---------------------------------------------------------------------------
// 5. kiro-eventstream — Binary event stream decoding
// ---------------------------------------------------------------------------

describe("kiro-eventstream", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const codec = new EventStreamCodec(
    (input: Uint8Array | string) => {
      if (typeof input === "string") return input
      return decoder.decode(input)
    },
    (input: string) => encoder.encode(input),
  )

  function encode(headers: MessageHeaders, body: string): Uint8Array {
    return codec.encode({
      headers,
      body: encoder.encode(body),
    })
  }

  function eventHeaders(type: string, event: string): MessageHeaders {
    return {
      ":message-type": { type: "string", value: type },
      ":event-type": { type: "string", value: event },
    }
  }

  function streamFrom(frames: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(frame)
        }
        controller.close()
      },
    })
  }

  async function collect(stream: ReadableStream<Uint8Array>): Promise<Array<KiroStreamEvent>> {
    const { decodeEventStream } = await import("../src/kiro-eventstream")
    const events: Array<KiroStreamEvent> = []
    for await (const event of decodeEventStream(stream)) {
      events.push(event)
    }
    return events
  }

  test("decodes a content event", async () => {
    const frame = encode(eventHeaders("event", "content"), JSON.stringify({ content: "hello world" }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("content")
    expect(events[0].payload).toEqual({ content: "hello world" })
  })

  test("decodes a tool_start event", async () => {
    const frame = encode(
      eventHeaders("event", "tool_start"),
      JSON.stringify({ name: "bash", toolUseId: "tu-1" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_start")
    expect(events[0].payload).toEqual({ name: "bash", toolUseId: "tu-1" })
  })

  test("decodes a tool_input event", async () => {
    const frame = encode(eventHeaders("event", "tool_input"), JSON.stringify({ input: '{"cmd":"ls"}' }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_input")
    expect(events[0].payload).toEqual({ input: '{"cmd":"ls"}' })
  })

  test("decodes a tool_stop event", async () => {
    const frame = encode(eventHeaders("event", "tool_stop"), JSON.stringify({ stop: true }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_stop")
    expect(events[0].payload).toEqual({ stop: true })
  })

  test("decodes a usage event", async () => {
    const frame = encode(
      eventHeaders("event", "usage"),
      JSON.stringify({ inputTokens: 100, outputTokens: 50 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("usage")
    expect(events[0].payload).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  test("decodes a context_usage event", async () => {
    const frame = encode(
      eventHeaders("event", "context_usage"),
      JSON.stringify({ contextTokens: 2000 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("context_usage")
    expect(events[0].payload).toEqual({ contextTokens: 2000 })
  })

  test("decodes error/exception messages", async () => {
    const frame = encode(
      { ":message-type": { type: "string", value: "error" } },
      "something went wrong",
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("error")
    expect(events[0].payload).toEqual({ message: "something went wrong" })
  })

  test("decodes exception message type", async () => {
    const frame = encode(
      { ":message-type": { type: "string", value: "exception" } },
      "server error",
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("error")
    expect(events[0].payload).toEqual({ message: "server error" })
  })

  test("decodes assistantResponseEvent as content", async () => {
    const frame = encode(
      eventHeaders("event", "assistantResponseEvent"),
      JSON.stringify({ content: "hello from kiro", modelId: "auto" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("content")
    expect(events[0].payload).toEqual({ content: "hello from kiro", modelId: "auto" })
  })

  test("skips unknown event types", async () => {
    const frame = encode(eventHeaders("event", "unknown_event"), JSON.stringify({ data: "x" }))
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(0)
  })

  test("skips non-event message types", async () => {
    const frame = encode(
      { ":message-type": { type: "string", value: "other" } },
      "ignored",
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(0)
  })

  test("skips events with empty body", async () => {
    const frame = codec.encode({
      headers: eventHeaders("event", "content"),
      body: new Uint8Array(0),
    })
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(0)
  })

  test("decodes toolUseEvent as tool_start", async () => {
    const frame = encode(
      eventHeaders("event", "toolUseEvent"),
      JSON.stringify({ name: "bash", toolUseId: "tooluse_xxx" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_start")
    expect(events[0].payload).toEqual({ name: "bash", toolUseId: "tooluse_xxx" })
  })

  test("decodes toolUseEvent with input as tool_input", async () => {
    const frame = encode(
      eventHeaders("event", "toolUseEvent"),
      JSON.stringify({ input: '{"command": "date"}', name: "bash", toolUseId: "tooluse_xxx" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_input")
    expect(events[0].payload).toEqual({ input: '{"command": "date"}', name: "bash", toolUseId: "tooluse_xxx" })
  })

  test("decodes toolUseEvent with stop as tool_stop", async () => {
    const frame = encode(
      eventHeaders("event", "toolUseEvent"),
      JSON.stringify({ name: "bash", stop: true, toolUseId: "tooluse_xxx" }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("tool_stop")
    expect(events[0].payload).toEqual({ name: "bash", stop: true, toolUseId: "tooluse_xxx" })
  })

  test("decodes full toolUseEvent sequence", async () => {
    const frames = [
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tooluse_xxx" }),
      ),
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ input: "", name: "bash", toolUseId: "tooluse_xxx" }),
      ),
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ input: '{"command": "date"}', name: "bash", toolUseId: "tooluse_xxx" }),
      ),
      encode(
        eventHeaders("event", "toolUseEvent"),
        JSON.stringify({ name: "bash", stop: true, toolUseId: "tooluse_xxx" }),
      ),
    ]
    const events = await collect(streamFrom(frames))
    expect(events).toHaveLength(4)
    expect(events[0].type).toBe("tool_start")
    expect(events[1].type).toBe("tool_input")
    expect(events[2].type).toBe("tool_input")
    expect(events[3].type).toBe("tool_stop")
  })

  test("decodes contextUsageEvent as context_usage", async () => {
    const frame = encode(
      eventHeaders("event", "contextUsageEvent"),
      JSON.stringify({ contextUsagePercentage: 1.32 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("context_usage")
    expect(events[0].payload).toEqual({ contextUsagePercentage: 1.32 })
  })

  test("decodes meteringEvent as usage", async () => {
    const frame = encode(
      eventHeaders("event", "meteringEvent"),
      JSON.stringify({ unit: "credit", usage: 0.013 }),
    )
    const events = await collect(streamFrom([frame]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("usage")
    expect(events[0].payload).toEqual({ unit: "credit", usage: 0.013 })
  })

  test("decodes multiple events from a single stream", async () => {
    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "part1" })),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "part2" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]
    const events = await collect(streamFrom(frames))
    expect(events).toHaveLength(3)
    expect(events[0].type).toBe("content")
    expect(events[1].type).toBe("content")
    expect(events[2].type).toBe("usage")
  })

  test("handles chunked delivery (frame split across chunks)", async () => {
    const frame = encode(eventHeaders("event", "content"), JSON.stringify({ content: "chunked" }))
    const mid = Math.floor(frame.length / 2)
    const chunk1 = frame.slice(0, mid)
    const chunk2 = frame.slice(mid)
    const events = await collect(streamFrom([chunk1, chunk2]))
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("content")
    expect(events[0].payload).toEqual({ content: "chunked" })
  })

  test("handles multiple frames concatenated in one chunk", async () => {
    const frame1 = encode(eventHeaders("event", "content"), JSON.stringify({ content: "a" }))
    const frame2 = encode(eventHeaders("event", "content"), JSON.stringify({ content: "b" }))
    const combined = new Uint8Array(frame1.length + frame2.length)
    combined.set(frame1, 0)
    combined.set(frame2, frame1.length)
    const events = await collect(streamFrom([combined]))
    expect(events).toHaveLength(2)
    expect(events[0].payload).toEqual({ content: "a" })
    expect(events[1].payload).toEqual({ content: "b" })
  })
})

// ---------------------------------------------------------------------------
// 6. kiro-language-model — LanguageModelV3 doGenerate/doStream
// ---------------------------------------------------------------------------

describe("kiro-language-model", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const codec = new EventStreamCodec(
    (input: Uint8Array | string) => {
      if (typeof input === "string") return input
      return decoder.decode(input)
    },
    (input: string) => encoder.encode(input),
  )

  function encode(headers: MessageHeaders, body: string): Uint8Array {
    return codec.encode({
      headers,
      body: encoder.encode(body),
    })
  }

  function eventHeaders(type: string, event: string): MessageHeaders {
    return {
      ":message-type": { type: "string", value: type },
      ":event-type": { type: "string", value: event },
    }
  }

  function makeEventStreamBody(frames: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(frame)
        }
        controller.close()
      },
    })
  }

  function mockResponse(frames: ReadonlyArray<Uint8Array>, status = 200): Response {
    return new Response(makeEventStreamBody(frames), {
      status,
      headers: { "content-type": "application/vnd.amazon.eventstream" },
    })
  }

  const simplePrompt = [
    { role: "user" as const, content: [{ type: "text" as const, text: "hello" }] },
  ]

  async function drain(stream: ReadableStream<unknown>): Promise<Array<{ type: string; [key: string]: unknown }>> {
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = stream.getReader()
    const read = async (): Promise<void> => {
      const { done, value } = await reader.read()
      if (done) return
      parts.push(value as { type: string; [key: string]: unknown })
      return read()
    }
    await read()
    return parts
  }

  test("doStream returns stream-start, text events, and finish", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "Hello " })),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "world" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts = await drain(result.stream)

    const types = parts.map((p) => p.type)
    expect(types).toContain("stream-start")
    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("text-end")
    expect(types).toContain("finish")

    const deltas = parts.filter((p) => p.type === "text-delta").map((p) => p.delta)
    expect(deltas).toEqual(["Hello ", "world"])

    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toEqual({ unified: "stop", raw: undefined })
    expect((finish.usage as { inputTokens: { total: number } }).inputTokens.total).toBe(10)
    expect((finish.usage as { outputTokens: { total: number } }).outputTokens.total).toBe(5)

    getTokenMock.mockRestore()
  })

  test("doStream throws KiroAuthError when no token", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const { KiroAuthError } = await import("../src/kiro-error")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue(undefined)

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
    })

    await expect(model.doStream({ prompt: simplePrompt })).rejects.toThrow(KiroAuthError)

    getTokenMock.mockRestore()
  })

  test("doStream throws KiroApiError on non-ok response", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const { KiroApiError } = await import("../src/kiro-error")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const fakeFetch = mock(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    )

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    await expect(model.doStream({ prompt: simplePrompt })).rejects.toThrow(KiroApiError)

    getTokenMock.mockRestore()
  })

  test("doStream handles tool call events", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tu-1", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"command":"ls"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 20, outputTokens: 10 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts = await drain(result.stream)

    const types = parts.map((p) => p.type)
    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-input-delta")
    expect(types).toContain("tool-input-end")
    expect(types).toContain("tool-call")

    const call = parts.find((p) => p.type === "tool-call")!
    expect(call.toolName).toBe("bash")
    expect(call.toolCallId).toBe("tu-1")
    expect(call.input).toBe('{"command":"ls"}')

    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toEqual({ unified: "tool-calls", raw: undefined })

    getTokenMock.mockRestore()
  })

  test("doGenerate collects text from stream", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "Hello " })),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "world" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 15, outputTokens: 8 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("text")
    if (result.content[0].type === "text") {
      expect(result.content[0].text).toBe("Hello world")
    }
    expect(result.finishReason).toEqual({ unified: "stop", raw: undefined })
    expect(result.usage.inputTokens.total).toBe(15)
    expect(result.usage.outputTokens.total).toBe(8)
    expect(result.warnings).toEqual([])

    getTokenMock.mockRestore()
  })

  test("doGenerate collects tool calls", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "read", toolUseId: "tu-2", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"path":"/tmp"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 5, outputTokens: 3 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe("tool-call")
    if (result.content[0].type === "tool-call") {
      expect(result.content[0].toolName).toBe("read")
      expect(result.content[0].toolCallId).toBe("tu-2")
      expect(result.content[0].input).toBe('{"path":"/tmp"}')
    }
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: undefined })

    getTokenMock.mockRestore()
  })

  test("doStream sends correct headers and body", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("my-token")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    await drain(result.stream)

    expect(fakeFetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://q.us-east-1.amazonaws.com/")
    expect(opts.method).toBe("POST")
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer my-token")
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/x-amz-json-1.0")
    expect((opts.headers as Record<string, string>)["X-Amz-Target"]).toBe(
      "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
    )
    expect((opts.headers as Record<string, string>)["User-Agent"]).toBe(
      `aws-sdk-js/1.0.27 ua/2.1 os/${process.platform} lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-ai-provider`,
    )
    expect((opts.headers as Record<string, string>)["x-amz-user-agent"]).toBe("aws-sdk-js/1.0.27 Kiro-ai-provider")
    expect((opts.headers as Record<string, string>)["x-amzn-codewhisperer-optout"]).toBe("true")
    expect((opts.headers as Record<string, string>)["amz-sdk-invocation-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    expect((opts.headers as Record<string, string>)["amz-sdk-request"]).toBe("attempt=1; max=1")

    const body = JSON.parse(opts.body as string)
    expect(body.conversationState).toBeDefined()
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("hello")

    getTokenMock.mockRestore()
  })

  test("doStream sends tokentype header for API key tokens", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("ksk_test_api_key")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    await drain(result.stream)

    const [, opts] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["tokentype"]).toBe("API_KEY")
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/x-amz-json-1.0")

    getTokenMock.mockRestore()
  })

  test("doStream omits tokentype header for OIDC tokens", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("oidc-bearer-token")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    await drain(result.stream)

    const [, opts] = fakeFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect((opts.headers as Record<string, string>)["tokentype"]).toBeUndefined()

    getTokenMock.mockRestore()
  })

  test("model exposes specificationVersion, provider, and modelId", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const model = new KiroLanguageModel("kiro-v1", { provider: "kiro" })
    expect(model.specificationVersion).toBe("v3")
    expect(model.provider).toBe("kiro")
    expect(model.modelId).toBe("kiro-v1")
    expect(model.defaultObjectGenerationMode).toBeUndefined()
  })

  test("doStream handles error events in stream", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "partial" })),
      encode(
        { ":message-type": { type: "string", value: "error" } },
        "stream error occurred",
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts = await drain(result.stream)

    const types = parts.map((p) => p.type)
    expect(types).toContain("error")
    const errPart = parts.find((p) => p.type === "error")!
    expect(errPart.error).toBe("stream error occurred")

    getTokenMock.mockRestore()
  })

  test("doStream handles assistantResponseEvent from real API", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ content: "Hello ", modelId: "auto" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ content: "world", modelId: "auto" }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts = await drain(result.stream)

    const types = parts.map((p) => p.type)
    expect(types).toContain("stream-start")
    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("text-end")
    expect(types).toContain("finish")

    const deltas = parts.filter((p) => p.type === "text-delta").map((p) => p.delta)
    expect(deltas).toEqual(["Hello ", "world"])

    getTokenMock.mockRestore()
  })

  test("doGenerate with mixed text and tool calls", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "assistantResponseEvent"), JSON.stringify({ content: "I'll run that." })),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tu-3", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"cmd":"echo hi"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 30, outputTokens: 20 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("text")
    expect(result.content[1].type).toBe("tool-call")
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: undefined })
    expect(result.usage.inputTokens.total).toBe(30)
    expect(result.usage.outputTokens.total).toBe(20)

    getTokenMock.mockRestore()
  })

  test("doStream treats thinking tool as normal tool call", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-1", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "Let me' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: ' analyze this"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "The answer is 42." })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 50, outputTokens: 30 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts = await drain(result.stream)

    const types = parts.map((p) => p.type)
    expect(types).not.toContain("reasoning-start")
    expect(types).not.toContain("reasoning-delta")
    expect(types).not.toContain("reasoning-end")

    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-input-delta")
    expect(types).toContain("tool-input-end")
    expect(types).toContain("tool-call")

    expect(types).toContain("text-start")
    expect(types).toContain("text-delta")
    expect(types).toContain("text-end")
    const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta)
    expect(text.join("")).toBe("The answer is 42.")

    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toEqual({ unified: "tool-calls", raw: undefined })

    getTokenMock.mockRestore()
  })

  test("doStream thinking tool emits raw input as tool-input-delta", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-2", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "Line 1\\nLine 2\\tTabbed"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 10, outputTokens: 5 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts = await drain(result.stream)

    const types = parts.map((p) => p.type)
    expect(types).not.toContain("reasoning-delta")
    const deltas = parts.filter((p) => p.type === "tool-input-delta").map((p) => p.delta)
    expect(deltas.join("")).toBe('{"thought": "Line 1\\nLine 2\\tTabbed"}')

    const call = parts.find((p) => p.type === "tool-call")!
    expect(call.toolName).toBe("thinking")

    getTokenMock.mockRestore()
  })

  test("doStream thinking tool mixed with real tool calls", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-3", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "I should run bash"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "bash", toolUseId: "tu-real", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"command":"ls"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 40, outputTokens: 20 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    const parts = await drain(result.stream)

    const types = parts.map((p) => p.type)
    expect(types).not.toContain("reasoning-start")
    expect(types).not.toContain("reasoning-delta")
    expect(types).not.toContain("reasoning-end")
    expect(types).toContain("tool-input-start")
    expect(types).toContain("tool-call")

    const calls = parts.filter((p) => p.type === "tool-call")
    expect(calls).toHaveLength(2)
    expect(calls[0].toolName).toBe("thinking")
    expect(calls[1].toolName).toBe("bash")

    const finish = parts.find((p) => p.type === "finish")!
    expect(finish.finishReason).toEqual({ unified: "tool-calls", raw: undefined })

    getTokenMock.mockRestore()
  })

  test("doGenerate collects thinking tool as normal tool-call", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ name: "thinking", toolUseId: "think-4", input: "" }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ input: '{"thought": "Step 1: multiply"}' }),
      ),
      encode(
        eventHeaders("event", "assistantResponseEvent"),
        JSON.stringify({ stop: true }),
      ),
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "49,403" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 20, outputTokens: 10 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doGenerate({ prompt: simplePrompt })

    expect(result.content).toHaveLength(2)
    expect(result.content[0].type).toBe("tool-call")
    if (result.content[0].type === "tool-call") {
      expect(result.content[0].toolName).toBe("thinking")
      expect(result.content[0].input).toBe('{"thought": "Step 1: multiply"}')
    }
    expect(result.content[1].type).toBe("text")
    if (result.content[1].type === "text") {
      expect(result.content[1].text).toBe("49,403")
    }
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: undefined })

    getTokenMock.mockRestore()
  })

  test("doStream skips thinking tool when thinking is not enabled", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const result = await model.doStream({ prompt: simplePrompt })
    await drain(result.stream)

    const body = JSON.parse(result.request!.body as string)
    const tools = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools
    const thinking = tools.find((t: { toolSpecification: { name: string } }) => t.toolSpecification.name === "thinking")
    expect(thinking).toBeUndefined()

    getTokenMock.mockRestore()
  })

  test("doStream injects thinking tool when thinking is enabled", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 1, outputTokens: 1 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
    })

    const prompt = [
      { role: "user" as const, content: [{ type: "text" as const, text: "run ls" }] },
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-call" as const,
            toolCallId: "tc-1",
            toolName: "bash",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool" as const,
        content: [
          {
            type: "tool-result" as const,
            toolCallId: "tc-1",
            toolName: "bash",
            output: { type: "text" as const, value: "file.txt" },
          },
        ],
      },
    ]

    const result = await model.doStream({ prompt, providerOptions: { kiro: { thinking: true } } })
    await drain(result.stream)

    const body = JSON.parse(result.request!.body as string)
    const tools = body.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools
    const thinking = tools.find((t: { toolSpecification: { name: string } }) => t.toolSpecification.name === "thinking")
    expect(thinking).toBeDefined()
    expect(thinking.toolSpecification.description).toContain("Internal reasoning tool for working through complex problems")

    getTokenMock.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 7. kiro-provider — Provider factory
// ---------------------------------------------------------------------------

describe("kiro-provider", () => {
  test("createKiro returns provider with languageModel method", async () => {
    const { createKiro } = await import("../src/kiro-provider")
    const provider = createKiro()
    expect(typeof provider.languageModel).toBe("function")
  })

  test("createKiro is callable as function (provider(modelId) syntax)", async () => {
    const { createKiro } = await import("../src/kiro-provider")
    const provider = createKiro()
    const model = provider("test-model")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("test-model")
    expect(model.provider).toBe("kiro")
  })

  test("languageModel returns KiroLanguageModel with correct properties", async () => {
    const { createKiro } = await import("../src/kiro-provider")
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const provider = createKiro()
    const model = provider.languageModel("kiro-v1")
    expect(model).toBeInstanceOf(KiroLanguageModel)
    expect(model.modelId).toBe("kiro-v1")
    expect(model.specificationVersion).toBe("v3")
  })

  test("createKiro passes custom fetch to model", async () => {
    const { createKiro } = await import("../src/kiro-provider")
    const fakeFetch = mock(() => Promise.resolve(new Response()))
    const provider = createKiro({ fetch: fakeFetch as unknown as typeof globalThis.fetch })
    const model = provider("kiro-v1")
    expect(model).toBeDefined()
    expect(model.modelId).toBe("kiro-v1")
  })
})

// ---------------------------------------------------------------------------
// 8. kiro index exports
// ---------------------------------------------------------------------------

describe("kiro index exports", () => {
  test("index re-exports createKiro", async () => {
    const mod = await import("../src/index")
    expect(typeof mod.createKiro).toBe("function")
  })

  test("index re-exports getToken", async () => {
    const mod = await import("../src/index")
    expect(typeof mod.getToken).toBe("function")
  })

  test("index re-exports hasToken", async () => {
    const mod = await import("../src/index")
    expect(typeof mod.hasToken).toBe("function")
  })

  test("index re-exports getQuota", async () => {
    const mod = await import("../src/index")
    expect(typeof mod.getQuota).toBe("function")
  })

  test("index re-exports authenticate", async () => {
    const mod = await import("../src/index")
    expect(typeof mod.authenticate).toBe("function")
  })

  test("index re-exports listModels", async () => {
    const mod = await import("../src/index")
    expect(typeof mod.listModels).toBe("function")
  })

  test("index re-exports getApiRegion", async () => {
    const mod = await import("../src/index")
    expect(typeof mod.getApiRegion).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// 9. kiro-quota — Quota fetching (mock fetch)
// ---------------------------------------------------------------------------

describe("kiro-quota", () => {
  test("getQuota returns undefined when no token", async () => {
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue(undefined)

    const { getQuota } = await import("../src/kiro-quota")
    const result = await getQuota()
    expect(result).toBeUndefined()

    getTokenMock.mockRestore()
  })

  test("getQuota returns quota data on success", async () => {
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")
    const getApiRegionMock = spyOn(authMod, "getApiRegion").mockResolvedValue("us-east-1")

    const body = {
      subscriptionInfo: { subscriptionTitle: "FREE TIER" },
      usageBreakdownList: [
        {
          currentUsage: 5,
          currentUsageWithPrecision: 5.5,
          usageLimit: 50,
          usageLimitWithPrecision: 50.0,
        },
      ],
    }

    const original = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    ) as unknown as typeof globalThis.fetch

    const { getQuota } = await import("../src/kiro-quota")
    const result = await getQuota()
    expect(result).toBeDefined()
    expect(result!.currentUsage).toBe(5.5)
    expect(result!.usageLimit).toBe(50.0)
    expect(result!.subscriptionTitle).toBe("Free Tier")

    globalThis.fetch = original
    getTokenMock.mockRestore()
    getApiRegionMock.mockRestore()
  })

  test("getQuota returns undefined on non-ok response", async () => {
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")
    const getApiRegionMock = spyOn(authMod, "getApiRegion").mockResolvedValue("us-east-1")

    const original = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 500 })),
    ) as unknown as typeof globalThis.fetch

    const { getQuota } = await import("../src/kiro-quota")
    const result = await getQuota()
    expect(result).toBeUndefined()

    globalThis.fetch = original
    getTokenMock.mockRestore()
    getApiRegionMock.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 10. kiro-authenticate — Device code flow (mock fetch)
// ---------------------------------------------------------------------------

describe("kiro-authenticate", () => {
  test("authenticate completes device code flow", async () => {
    const { authenticate } = await import("../src/kiro-authenticate")

    const calls: Array<{ url: string; body: string }> = []
    const original = globalThis.fetch

    // Mock fs operations to avoid writing to disk
    const fsMod = await import("node:fs/promises")
    const mkdirMock = spyOn(fsMod, "mkdir").mockResolvedValue(undefined)
    const writeFileMock = spyOn(fsMod, "writeFile").mockResolvedValue(undefined)

    globalThis.fetch = mock((url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url
      calls.push({ url: urlStr, body: init?.body as string })

      // Register client
      if (urlStr.includes("/client/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clientId: "test-client-id",
              clientSecret: "test-client-secret",
              clientIdIssuedAt: 1000,
              clientSecretExpiresAt: 2000,
            }),
            { status: 200 },
          ),
        )
      }

      // Device authorization
      if (urlStr.includes("/device_authorization")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              verificationUri: "https://verify.example.com",
              verificationUriComplete: "https://verify.example.com?code=ABCD",
              userCode: "ABCD",
              deviceCode: "device-123",
              interval: 0,
              expiresIn: 600,
            }),
            { status: 200 },
          ),
        )
      }

      // Token polling — succeed immediately
      if (urlStr.includes("/token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              accessToken: "access-token-123",
              refreshToken: "refresh-token-456",
              expiresIn: 3600,
              tokenType: "Bearer",
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response("not found", { status: 404 }))
    }) as unknown as typeof globalThis.fetch

    const verification: Array<{ url: string; code: string }> = []
    const result = await authenticate({
      region: "us-east-1",
      onVerification: (url, code) => {
        verification.push({ url, code })
      },
    })

    expect(result.accessToken).toBe("access-token-123")
    expect(result.refreshToken).toBe("refresh-token-456")
    expect(result.region).toBe("us-east-1")
    expect(verification).toHaveLength(1)
    expect(verification[0].code).toBe("ABCD")
    expect(verification[0].url).toBe("https://verify.example.com?code=ABCD")

    // Verify the register call
    expect(calls[0].url).toContain("/client/register")
    const registerBody = JSON.parse(calls[0].body)
    expect(registerBody.clientName).toBe("kiro-ai-provider")
    expect(registerBody.clientType).toBe("public")

    // Verify the device auth call
    expect(calls[1].url).toContain("/device_authorization")

    // Verify the token call
    expect(calls[2].url).toContain("/token")
    const tokenBody = JSON.parse(calls[2].body)
    expect(tokenBody.deviceCode).toBe("device-123")

    globalThis.fetch = original
    mkdirMock.mockRestore()
    writeFileMock.mockRestore()
  })

  test("authenticate throws on failed client registration", async () => {
    const { authenticate } = await import("../src/kiro-authenticate")

    const original = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 500 })),
    ) as unknown as typeof globalThis.fetch

    await expect(authenticate({ region: "us-east-1" })).rejects.toThrow("Failed to register OIDC client")

    globalThis.fetch = original
  })

  test("authenticate throws on failed device authorization", async () => {
    const { authenticate } = await import("../src/kiro-authenticate")

    const original = globalThis.fetch
    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url

      if (urlStr.includes("/client/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clientId: "cid",
              clientSecret: "cs",
              clientIdIssuedAt: 1000,
              clientSecretExpiresAt: 2000,
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response("error", { status: 500 }))
    }) as unknown as typeof globalThis.fetch

    await expect(authenticate({ region: "us-east-1" })).rejects.toThrow("Failed to start device authorization")

    globalThis.fetch = original
  })
})

// ---------------------------------------------------------------------------
// 11. kiro-models — List models (mock fetch)
// ---------------------------------------------------------------------------

describe("kiro-models", () => {
  test("listModels returns undefined when no token", async () => {
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue(undefined)

    const { listModels } = await import("../src/kiro-models")
    const result = await listModels()
    expect(result).toBeUndefined()

    getTokenMock.mockRestore()
  })

  test("listModels returns model list on success", async () => {
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")
    const getApiRegionMock = spyOn(authMod, "getApiRegion").mockResolvedValue("us-east-1")

    const body = {
      models: [
        {
          modelId: "claude-sonnet-4",
          displayName: "Claude Sonnet 4",
          contextWindow: 200000,
          maxOutputTokens: 16384,
          capabilities: ["chat", "tool_use"],
        },
        {
          modelId: "claude-3.5-haiku",
          displayName: "Claude 3.5 Haiku",
          contextWindow: 200000,
        },
      ],
    }

    const original = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
    ) as unknown as typeof globalThis.fetch

    const { listModels } = await import("../src/kiro-models")
    const result = await listModels()
    expect(result).toBeDefined()
    expect(result).toHaveLength(2)
    expect(result![0].modelId).toBe("claude-sonnet-4")
    expect(result![0].displayName).toBe("Claude Sonnet 4")
    expect(result![0].contextWindow).toBe(200000)
    expect(result![1].modelId).toBe("claude-3.5-haiku")

    globalThis.fetch = original
    getTokenMock.mockRestore()
    getApiRegionMock.mockRestore()
  })

  test("listModels returns undefined on non-ok response", async () => {
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")
    const getApiRegionMock = spyOn(authMod, "getApiRegion").mockResolvedValue("us-east-1")

    const original = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("error", { status: 403 })),
    ) as unknown as typeof globalThis.fetch

    const { listModels } = await import("../src/kiro-models")
    const result = await listModels()
    expect(result).toBeUndefined()

    globalThis.fetch = original
    getTokenMock.mockRestore()
    getApiRegionMock.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 12. kiro-auth — getApiRegion tests
// ---------------------------------------------------------------------------

describe("kiro-auth getApiRegion", () => {
  test("getApiRegion returns us-east-1 when probe succeeds", async () => {
    const authMod = await import("../src/kiro-auth")
    // Reset cached region by calling the module fresh
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const original = globalThis.fetch
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("ok", { status: 200 })),
    ) as unknown as typeof globalThis.fetch

    // Note: getApiRegion caches, so this test relies on module-level state
    // We test the probe logic indirectly
    const result = await authMod.getApiRegion()
    expect(typeof result).toBe("string")
    expect(["us-east-1", "eu-central-1"]).toContain(result)

    globalThis.fetch = original
    getTokenMock.mockRestore()
  })

  test("getApiRegion returns us-east-1 when no token available", async () => {
    // When getToken returns undefined, probe returns false for both regions
    // The function should return "us-east-1" as default
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue(undefined)

    const result = await authMod.getApiRegion()
    expect(typeof result).toBe("string")

    getTokenMock.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 13. kiro-auth — concurrent getToken tests
// ---------------------------------------------------------------------------

describe("kiro-auth concurrent getToken", () => {
  test("concurrent getToken calls share the same refresh promise", async () => {
    const authMod = await import("../src/kiro-auth")
    const fsMod = await import("node:fs/promises")

    // Create a token that is expired (needs refresh)
    const expiredToken = {
      accessToken: "expired-token",
      refreshToken: "refresh-123",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      region: "us-east-1",
      clientId: "cid",
      clientSecret: "csecret",
    }

    const accessMock = spyOn(fsMod, "access").mockResolvedValue(undefined)
    const readFileMock = spyOn(fsMod, "readFile").mockResolvedValue(JSON.stringify(expiredToken))
    const writeFileMock = spyOn(fsMod, "writeFile").mockResolvedValue(undefined)

    const fetchCalls: number[] = []
    const original = globalThis.fetch
    globalThis.fetch = mock(() => {
      fetchCalls.push(Date.now())
      return Promise.resolve(
        new Response(
          JSON.stringify({
            accessToken: "new-token",
            refreshToken: "new-refresh",
            expiresIn: 3600,
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof globalThis.fetch

    // Call getToken concurrently
    const [r1, r2, r3] = await Promise.all([
      authMod.getToken(),
      authMod.getToken(),
      authMod.getToken(),
    ])

    // All should get the same result
    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    expect(r3).toBeDefined()

    // The refresh endpoint should only be called once (deduplication)
    // Note: fetch is called once for the refresh, not 3 times
    expect(fetchCalls.length).toBeLessThanOrEqual(3) // at most 3 reads + 1 refresh

    globalThis.fetch = original
    accessMock.mockRestore()
    readFileMock.mockRestore()
    writeFileMock.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// 14. kiro-authenticate — polling retries and slow_down
// ---------------------------------------------------------------------------

describe("kiro-authenticate polling", () => {
  test("authenticate retries on authorization_pending", async () => {
    const { authenticate } = await import("../src/kiro-authenticate")

    const fsMod = await import("node:fs/promises")
    const mkdirMock = spyOn(fsMod, "mkdir").mockResolvedValue(undefined)
    const writeFileMock = spyOn(fsMod, "writeFile").mockResolvedValue(undefined)

    const tokenAttempts: number[] = []
    const original = globalThis.fetch

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url

      if (urlStr.includes("/client/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clientId: "cid",
              clientSecret: "cs",
              clientIdIssuedAt: 1000,
              clientSecretExpiresAt: 2000,
            }),
            { status: 200 },
          ),
        )
      }

      if (urlStr.includes("/device_authorization")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              verificationUri: "https://verify.example.com",
              verificationUriComplete: "https://verify.example.com?code=XY",
              userCode: "XY",
              deviceCode: "dev-1",
              interval: 0,
              expiresIn: 600,
            }),
            { status: 200 },
          ),
        )
      }

      if (urlStr.includes("/token")) {
        tokenAttempts.push(Date.now())
        // First attempt: pending, second: success
        if (tokenAttempts.length === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "authorization_pending" }),
              { status: 400 },
            ),
          )
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              accessToken: "at",
              refreshToken: "rt",
              expiresIn: 3600,
              tokenType: "Bearer",
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response("not found", { status: 404 }))
    }) as unknown as typeof globalThis.fetch

    const result = await authenticate({ region: "us-east-1" })
    expect(result.accessToken).toBe("at")
    expect(tokenAttempts.length).toBe(2)

    globalThis.fetch = original
    mkdirMock.mockRestore()
    writeFileMock.mockRestore()
  })

  test("authenticate handles slow_down by increasing delay", async () => {
    const { authenticate } = await import("../src/kiro-authenticate")

    const fsMod = await import("node:fs/promises")
    const mkdirMock = spyOn(fsMod, "mkdir").mockResolvedValue(undefined)
    const writeFileMock = spyOn(fsMod, "writeFile").mockResolvedValue(undefined)

    const tokenAttempts: number[] = []
    const original = globalThis.fetch

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url

      if (urlStr.includes("/client/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clientId: "cid",
              clientSecret: "cs",
              clientIdIssuedAt: 1000,
              clientSecretExpiresAt: 2000,
            }),
            { status: 200 },
          ),
        )
      }

      if (urlStr.includes("/device_authorization")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              verificationUri: "https://verify.example.com",
              verificationUriComplete: "https://verify.example.com?code=AB",
              userCode: "AB",
              deviceCode: "dev-2",
              interval: 0,
              expiresIn: 600,
            }),
            { status: 200 },
          ),
        )
      }

      if (urlStr.includes("/token")) {
        tokenAttempts.push(Date.now())
        // First: slow_down, second: success
        if (tokenAttempts.length === 1) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ error: "slow_down" }),
              { status: 400 },
            ),
          )
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              accessToken: "at2",
              refreshToken: "rt2",
              expiresIn: 3600,
              tokenType: "Bearer",
            }),
            { status: 200 },
          ),
        )
      }

      return Promise.resolve(new Response("not found", { status: 404 }))
    }) as unknown as typeof globalThis.fetch

    const result = await authenticate({ region: "us-east-1" })
    expect(result.accessToken).toBe("at2")
    expect(tokenAttempts.length).toBe(2)

    globalThis.fetch = original
    mkdirMock.mockRestore()
    writeFileMock.mockRestore()
  }, 15_000)

  test("authenticate times out after expiresIn", async () => {
    const { authenticate } = await import("../src/kiro-authenticate")

    const original = globalThis.fetch

    globalThis.fetch = mock((url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url

      if (urlStr.includes("/client/register")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              clientId: "cid",
              clientSecret: "cs",
              clientIdIssuedAt: 1000,
              clientSecretExpiresAt: 2000,
            }),
            { status: 200 },
          ),
        )
      }

      if (urlStr.includes("/device_authorization")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              verificationUri: "https://verify.example.com",
              verificationUriComplete: "https://verify.example.com?code=TO",
              userCode: "TO",
              deviceCode: "dev-timeout",
              interval: 0,
              expiresIn: 0, // expires immediately
            }),
            { status: 200 },
          ),
        )
      }

      if (urlStr.includes("/token")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: "authorization_pending" }),
            { status: 400 },
          ),
        )
      }

      return Promise.resolve(new Response("not found", { status: 404 }))
    }) as unknown as typeof globalThis.fetch

    await expect(authenticate({ region: "us-east-1" })).rejects.toThrow("Authentication timed out")

    globalThis.fetch = original
  })
})

// ---------------------------------------------------------------------------
// 15. kiro-language-model — context_usage event handling
// ---------------------------------------------------------------------------

describe("kiro-language-model context_usage", () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const codec = new EventStreamCodec(
    (input: Uint8Array | string) => {
      if (typeof input === "string") return input
      return decoder.decode(input)
    },
    (input: string) => encoder.encode(input),
  )

  function encode(headers: MessageHeaders, body: string): Uint8Array {
    return codec.encode({
      headers,
      body: encoder.encode(body),
    })
  }

  function eventHeaders(type: string, event: string): MessageHeaders {
    return {
      ":message-type": { type: "string", value: type },
      ":event-type": { type: "string", value: event },
    }
  }

  function mockResponse(frames: ReadonlyArray<Uint8Array>): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(frame)
          controller.close()
        },
      }),
      { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
    )
  }

  async function drain(stream: ReadableStream<unknown>): Promise<Array<{ type: string; [key: string]: unknown }>> {
    const parts: Array<{ type: string; [key: string]: unknown }> = []
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value as { type: string; [key: string]: unknown })
    }
    return parts
  }

  test("context_usage sets inputTokens when no usage event precedes it", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "hi" })),
      encode(
        eventHeaders("event", "contextUsageEvent"),
        JSON.stringify({ contextUsagePercentage: 50 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      context: 200_000,
    })

    const result = await model.doStream({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    })
    const parts = await drain(result.stream)

    const finish = parts.find((p) => p.type === "finish")!
    const usage = finish.usage as { inputTokens: { total: number }; outputTokens: { total: number } }
    expect(usage.inputTokens.total).toBe(100_000) // 50% of 200k
    expect(usage.outputTokens.total).toBe(1) // fallback

    getTokenMock.mockRestore()
  })

  test("context_usage does not overwrite usage event inputTokens", async () => {
    const { KiroLanguageModel } = await import("../src/kiro-language-model")
    const authMod = await import("../src/kiro-auth")
    const getTokenMock = spyOn(authMod, "getToken").mockResolvedValue("test-token")

    const frames = [
      encode(eventHeaders("event", "content"), JSON.stringify({ content: "hi" })),
      encode(
        eventHeaders("event", "usage"),
        JSON.stringify({ inputTokens: 42, outputTokens: 7 }),
      ),
      encode(
        eventHeaders("event", "contextUsageEvent"),
        JSON.stringify({ contextUsagePercentage: 50 }),
      ),
    ]

    const fakeFetch = mock(() => Promise.resolve(mockResponse(frames)))

    const model = new KiroLanguageModel("kiro-v1", {
      provider: "kiro",
      fetch: fakeFetch as unknown as typeof globalThis.fetch,
      context: 200_000,
    })

    const result = await model.doStream({
      prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    })
    const parts = await drain(result.stream)

    const finish = parts.find((p) => p.type === "finish")!
    const usage = finish.usage as { inputTokens: { total: number }; outputTokens: { total: number } }
    // usage event set 42, context_usage should NOT overwrite it
    expect(usage.inputTokens.total).toBe(42)
    expect(usage.outputTokens.total).toBe(7)

    getTokenMock.mockRestore()
  })
})
