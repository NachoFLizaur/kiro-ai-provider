import { getToken, getApiRegion } from "./kiro-auth"

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
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "aws-sdk-js/1.0.27 ua/2.1 os/darwin lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-ai-provider",
            "x-amz-user-agent": "aws-sdk-js/1.0.27 Kiro-ai-provider",
            "x-amzn-codewhisperer-optout": "true",
          },
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
