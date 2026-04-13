import { EventStreamCodec } from "@smithy/eventstream-codec"
import type { Message, MessageHeaders } from "@smithy/types"
import type {
  KiroStreamEvent,
  KiroContentEvent,
  KiroToolStartEvent,
  KiroToolInputEvent,
  KiroToolStopEvent,
  KiroUsageEvent,
  KiroContextUsageEvent,
} from "./kiro-api-types"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const codec = new EventStreamCodec(
  (input: Uint8Array | string) => {
    if (typeof input === "string") return input
    return decoder.decode(input)
  },
  (input: string) => encoder.encode(input),
)

function merge(
  buffers: ReadonlyArray<Uint8Array>,
  total: number,
): Uint8Array {
  if (buffers.length === 1) return buffers[0]
  const merged = new Uint8Array(total)
  buffers.reduce((offset, buf) => {
    merged.set(buf, offset)
    return offset + buf.length
  }, 0)
  return merged
}

const MAX_FRAME = 16 * 1024 * 1024 // 16 MB

async function* chunked(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const buffer: Array<Uint8Array> = []
  const state = { total: 0 }

  for await (const chunk of stream) {
    buffer.push(chunk)
    state.total += chunk.length

    while (state.total >= 4) {
      const merged = merge(buffer, state.total)
      const view = new DataView(merged.buffer, merged.byteOffset)
      const length = view.getUint32(0, false)

      if (length > MAX_FRAME) throw new Error(`Event stream frame too large: ${length}`)

      if (state.total < length) break

      yield merged.slice(0, length)
      const remainder = merged.slice(length)
      buffer.length = 0
      if (remainder.length > 0) buffer.push(remainder)
      state.total = remainder.length
    }
  }
}

function header(
  headers: MessageHeaders,
  name: string,
): string | undefined {
  const entry = headers[name]
  if (!entry) return undefined
  if (entry.type === "string") return entry.value
  if (entry.type === "binary") return decoder.decode(entry.value)
  return String(entry.value)
}

const safeParse = (s: string): Record<string, unknown> | undefined => {
  try {
    const result = JSON.parse(s)
    if (typeof result === "object" && result !== null) return result as Record<string, unknown>
    return undefined
  } catch { return undefined }
}

function interpret(message: Message): KiroStreamEvent | undefined {
  const kind = header(message.headers, ":message-type")
  const event = header(message.headers, ":event-type")

  if (kind === "error" || kind === "exception") {
    const body = decoder.decode(message.body)
    return { type: "error", payload: { message: body } }
  }

  if (kind !== "event") return undefined

  if (message.body.length === 0) return undefined

  const body = decoder.decode(message.body)
  const payload = safeParse(body)
  if (!payload) return undefined

  switch (event) {
    case "assistantResponseEvent": {
      if ("content" in payload) return { type: "content", payload: payload as unknown as KiroContentEvent }
      if ("name" in payload) return { type: "tool_start", payload: payload as unknown as KiroToolStartEvent }
      if ("stop" in payload) return { type: "tool_stop", payload: payload as unknown as KiroToolStopEvent }
      if ("usage" in payload) return { type: "usage", payload: payload as unknown as KiroUsageEvent }
      if ("input" in payload) return { type: "tool_input", payload: payload as unknown as KiroToolInputEvent }
      return undefined
    }
    case "toolUseEvent": {
      if ("stop" in payload) return { type: "tool_stop", payload: payload as unknown as KiroToolStopEvent }
      if ("input" in payload) return { type: "tool_input", payload: payload as unknown as KiroToolInputEvent }
      return { type: "tool_start", payload: payload as unknown as KiroToolStartEvent }
    }
    case "contextUsageEvent":
      return { type: "context_usage", payload: payload as unknown as KiroContextUsageEvent }
    case "meteringEvent":
      return { type: "usage", payload: payload as unknown as KiroUsageEvent }
    case "content":
      return { type: "content", payload: payload as unknown as KiroContentEvent }
    case "tool_start":
      return { type: "tool_start", payload: payload as unknown as KiroToolStartEvent }
    case "tool_input":
      return { type: "tool_input", payload: payload as unknown as KiroToolInputEvent }
    case "tool_stop":
      return { type: "tool_stop", payload: payload as unknown as KiroToolStopEvent }
    case "usage":
      return { type: "usage", payload: payload as unknown as KiroUsageEvent }
    case "context_usage":
      return { type: "context_usage", payload: payload as unknown as KiroContextUsageEvent }
    default:
      return undefined
  }
}

function iterable(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in stream) {
    return stream as AsyncIterable<Uint8Array>
  }
  
  return {
    [Symbol.asyncIterator]() {
      const reader = (stream as ReadableStream<Uint8Array>).getReader()
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          const result = await reader.read()
          if (result.done) return { done: true, value: undefined }
          return { done: false, value: result.value }
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          await reader.cancel()
          reader.releaseLock()
          return { done: true, value: undefined }
        },
      }
    },
  }
}

export async function* decodeEventStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<KiroStreamEvent> {
  for await (const frame of chunked(iterable(stream))) {
    const message = codec.decode(frame)
    const event = interpret(message)
    if (event) yield event
  }
}
