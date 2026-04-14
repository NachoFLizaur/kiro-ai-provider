# kiro-ai-provider

Kiro (AWS) provider for the [Vercel AI SDK](https://sdk.vercel.ai). Implements `LanguageModelV3` for streaming chat with tool calling support.

## Install

```bash
npm install kiro-ai-provider
```

## Quick Start

```typescript
import { createKiro } from "kiro-ai-provider"
import { generateText } from "ai"

const kiro = createKiro()
const { text } = await generateText({
  model: kiro.languageModel("claude-sonnet-4.6"),
  prompt: "Hello!",
})
```

## Authentication

Kiro uses AWS SSO OIDC for authentication. Three options:

### 1. Authenticate via Kiro IDE or kiro-cli

If you've already logged into Kiro IDE or kiro-cli, the token at `~/.aws/sso/cache/kiro-auth-token.json` is picked up automatically.

### 2. Built-in device code flow

```typescript
import { authenticate } from "kiro-ai-provider"

await authenticate({
  startUrl: "https://view.awsapps.com/start", // Builder ID
  region: "us-east-1",
  onVerification: (url, code) => {
    console.log(`Open ${url} and enter code: ${code}`)
  },
})
```

For IAM Identity Center:

```typescript
await authenticate({
  startUrl: "https://d-xxxxxxxxxx.awsapps.com/start",
  region: "eu-west-1", // your IAM Identity Center region
})
```

You can also set `AWS_SSO_START_URL` and `AWS_SSO_REGION` as environment variables — they're used as defaults when `startUrl` or `region` aren't provided.



### 3. API key

Requires a Kiro Pro, Pro+, or Power subscription.

```bash
export KIRO_API_KEY=your-api-key
```

Generate an API key at [app.kiro.dev](https://app.kiro.dev). When set, the API key is used directly — no OIDC login needed.

## Models

```typescript
import { listModels } from "kiro-ai-provider"

const models = await listModels()
// Returns: [{ modelId: "claude-sonnet-4.6", modelName: "Claude Sonnet 4.6", ... }, ...]
```

Available models include `auto`, `claude-opus-4.6`, `claude-sonnet-4.6`, `claude-sonnet-4.5`, `claude-haiku-4.5`, `deepseek-3.2`, and more. Model availability depends on your subscription.

## Subscription Quota

```typescript
import { getQuota } from "kiro-ai-provider"

const quota = await getQuota()
// { currentUsage: 97.83, usageLimit: 10000, subscriptionTitle: "Kiro Power" }
```

## Configuration

```typescript
const kiro = createKiro({
  context: 200000, // context window size (for token estimation)
  region: "eu-central-1", // API region (auto-detected if not set)
})
```

The API region (`us-east-1` or `eu-central-1`) is auto-detected based on your token. You only need to set it if auto-detection doesn't work.

## Tool Calling

Tools work out of the box:

```typescript
import { createKiro } from "kiro-ai-provider"
import { streamText, tool } from "ai"

const result = streamText({
  model: createKiro().languageModel("claude-sonnet-4.6"),
  tools: {
    weather: tool({
      description: "Get the weather",
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => `Sunny in ${city}`,
    }),
  },
  prompt: "What's the weather in Tokyo?",
})
```

## Thinking Tool

The provider supports a built-in thinking tool for chain-of-thought reasoning. Enable it via providerOptions:

```typescript
import { createKiro } from "kiro-ai-provider"
import { streamText, tool } from "ai"

const result = streamText({
  model: createKiro().languageModel("claude-sonnet-4.6"),
  tools: {
    thinking: tool({
      description: "Internal reasoning tool",
      parameters: z.object({ thought: z.string() }),
      execute: async (args) => args.thought,
    }),
  },
  providerOptions: { kiro: { thinking: true } },
  prompt: "Debug this complex race condition...",
})
```

When enabled, the model can reason step-by-step before responding. Without `providerOptions.kiro.thinking = true`, the thinking tool is filtered out even if registered.

## Error Handling

```typescript
import { KiroAuthError, KiroApiError, KiroStreamError } from "kiro-ai-provider"

try {
  const { text } = await generateText({ model, prompt: "Hello" })
} catch (error) {
  if (error instanceof KiroAuthError) {
    // Token missing, expired, or refresh failed
  }
  if (error instanceof KiroApiError) {
    // API returned non-2xx — check error.data.status and error.data.body
  }
  if (error instanceof KiroStreamError) {
    // Event stream decoding failed
  }
}
```

## Environment Variables

| Variable | Description | Used when |
|----------|-------------|-----------|
| `AWS_SSO_START_URL` | IAM Identity Center start URL | Fallback when `authenticate()` startUrl is not provided |
| `AWS_SSO_REGION` | IAM Identity Center region | Fallback when `authenticate()` region is not provided |
| `KIRO_API_KEY` | API key for Pro, Pro+ or Power subscriptions | Used as bearer token directly, skips OIDC flow |

## How it works

The Kiro API uses AWS Event Stream binary protocol (not SSE or JSON). This package handles the binary framing and decoding via `@smithy/eventstream-codec`, translates between the AI SDK's message format and Kiro's `conversationState` format, and maps Kiro's event types to AI SDK stream parts.

## API Reference

### `createKiro(settings?)`

Creates a Kiro provider instance.

```typescript
interface KiroProviderSettings {
  context?: number    // Context window size for token estimation (default: auto-detected)
  region?: string     // API region (default: auto-detected from token)
  fetch?: typeof fetch // Custom fetch implementation
}
```

Returns a `KiroProvider` with a `.languageModel(modelId)` method.

### `authenticate(options?)`

Runs the OIDC device code flow.

```typescript
interface AuthenticateOptions {
  startUrl?: string                              // SSO start URL (or $AWS_SSO_START_URL)
  region?: string                                // OIDC region (or $AWS_SSO_REGION, default: "us-east-1")
  onVerification?: (url: string, code: string) => void  // Called with the browser URL and user code
}
```

### `listModels()`

Returns the available models for the authenticated user. Returns `undefined` if not authenticated.

### `getQuota()`

Returns subscription usage. Returns `undefined` if not authenticated.

```typescript
{ currentUsage: number, usageLimit: number, subscriptionTitle: string }
```

### `getToken()` / `hasToken()`

Low-level token access. `getToken()` returns the Bearer token string, `hasToken()` checks if a token file exists.

### `getApiRegion()`

Auto-detects the Kiro API region (`us-east-1` or `eu-central-1`) by probing the endpoints. Result is cached.

## Links

- [GitHub](https://github.com/NachoFLizaur/kiro-ai-provider)
- [npm](https://www.npmjs.com/package/kiro-ai-provider)
- [Issues](https://github.com/NachoFLizaur/kiro-ai-provider/issues)

## License

MIT
