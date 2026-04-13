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

### 3. Environment variables

```bash
export AWS_SSO_START_URL=https://d-xxxxxxxxxx.awsapps.com/start
export AWS_SSO_REGION=eu-west-1
```

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

## How it works

The Kiro API uses AWS Event Stream binary protocol (not SSE or JSON). This package handles the binary framing and decoding via `@smithy/eventstream-codec`, translates between the AI SDK's message format and Kiro's `conversationState` format, and maps Kiro's event types to AI SDK stream parts.

## License

MIT
