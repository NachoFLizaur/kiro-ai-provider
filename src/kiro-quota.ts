import { getToken, getApiRegion } from "./kiro-auth"
import { headers } from "./kiro-headers"

export function getQuota(token?: string): Promise<
  { currentUsage: number; usageLimit: number; subscriptionTitle: string } | undefined
> {
  return (token ? Promise.resolve(token) : getToken()).then((token) => {
    if (!token) return undefined
    return (token.startsWith("ksk_") ? Promise.resolve("us-east-1") : getApiRegion()).then((region) =>
      fetch(
        `https://q.${region}.amazonaws.com/`,
        {
          method: "POST",
          headers: {
            ...headers(token),
            "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
          },
          body: JSON.stringify({ origin: "AI_EDITOR", resourceType: "AGENTIC_REQUEST" }),
        },
      )
        .then((response) => {
          if (!response.ok) return undefined
          return response.json() as Promise<{
            subscriptionInfo: {
              subscriptionTitle: string
            }
            usageBreakdownList: Array<{
              currentUsage: number
              currentUsageWithPrecision: number
              usageLimit: number
              usageLimitWithPrecision: number
            }>
          }>
        })
        .then((body) => {
          if (!body) return undefined
          const item = body.usageBreakdownList[0]
          if (!item) return undefined
          return {
            currentUsage: item.currentUsageWithPrecision ?? item.currentUsage,
            usageLimit: item.usageLimitWithPrecision ?? item.usageLimit,
            subscriptionTitle: body.subscriptionInfo.subscriptionTitle
              .toLowerCase()
              .replace(/\b\w/g, (c) => c.toUpperCase()),
          }
        })
        .catch(() => undefined),
    )
  })
}
