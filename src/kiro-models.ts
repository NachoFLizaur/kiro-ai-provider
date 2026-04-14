import { getToken, getApiRegion } from "./kiro-auth"
import { headers } from "./kiro-headers"

export function listModels(): Promise<Array<{
  modelId: string
  displayName?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: ReadonlyArray<string>
}> | undefined> {
  return getToken()
    .then((token) => {
      if (!token) return undefined
      return getApiRegion().then((region) =>
        fetch(`https://q.${region}.amazonaws.com/`, {
          method: "POST",
          headers: {
            ...headers(token),
            "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
          },
          body: JSON.stringify({ origin: "AI_EDITOR" }),
        })
          .then((response) => {
            if (!response.ok) return undefined
            return response.json() as Promise<{
              models?: Array<{
                modelId: string
                displayName?: string
                contextWindow?: number
                maxOutputTokens?: number
                capabilities?: ReadonlyArray<string>
              }>
            }>
          })
          .then((body) => body?.models)
          .catch(() => undefined),
      )
    })
    .catch(() => undefined)
}
