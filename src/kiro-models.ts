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
        fetch(`https://q.${region}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR`, {
          method: "GET",
          headers: headers(token),
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
