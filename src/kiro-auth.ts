import path from "path"
import os from "os"
import { readFile, writeFile, access } from "node:fs/promises"
import { headers, validateRegion } from "./kiro-headers"

interface KiroTokenFile {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: string
  readonly region: string
  readonly clientId?: string
  readonly clientSecret?: string
  readonly clientIdHash?: string
  readonly authMethod?: string
  readonly provider?: string
}

export const TOKEN_PATH = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")

const BUFFER_MS = 300_000

const VALID_HASH = /^[a-zA-Z0-9_-]+$/

function resolve(token: KiroTokenFile): Promise<{ clientId: string; clientSecret: string } | undefined> {
  if (token.clientId) return Promise.resolve({ clientId: token.clientId, clientSecret: token.clientSecret ?? "" })
  if (!token.clientIdHash) return Promise.resolve(undefined)
  if (!VALID_HASH.test(token.clientIdHash)) return Promise.resolve(undefined)
  const ref = path.join(os.homedir(), ".aws", "sso", "cache", `${token.clientIdHash}.json`)
  return readFile(ref, "utf-8")
    .then((text) => JSON.parse(text) as { clientId: string; clientSecret: string })
    .then((data) => ({ clientId: data.clientId, clientSecret: data.clientSecret }))
    .catch((e: unknown) => {
      console.warn("[kiro-ai-provider]", e instanceof Error ? e.message : e)
      return undefined
    })
}

const cache: { current: KiroTokenFile | undefined; expires: number } = {
  current: undefined,
  expires: 0,
}

const pending: { token: Promise<string | undefined> | undefined; region: Promise<string> | undefined } = { token: undefined, region: undefined }

function read(): Promise<KiroTokenFile | undefined> {
  return access(TOKEN_PATH)
    .then(() => readFile(TOKEN_PATH, "utf-8"))
    .then((text) => JSON.parse(text) as KiroTokenFile)
    .catch((e: unknown) => {
      console.warn("[kiro-ai-provider]", e instanceof Error ? e.message : e)
      return undefined
    })
}

function write(token: KiroTokenFile): Promise<void> {
  return writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 })
    .then(() => {})
    .catch((e: unknown) => {
      console.warn("[kiro-ai-provider]", e instanceof Error ? e.message : e)
    })
}

function refresh(token: KiroTokenFile): Promise<string | undefined> {
  const url = `https://oidc.${validateRegion(token.region)}.amazonaws.com/token`
  return resolve(token).then((client) => {
    if (!client) return undefined
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grantType: "refresh_token",
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        refreshToken: token.refreshToken,
      }),
    })
      .then((response) => {
        if (!response.ok) return undefined
        return response.json() as Promise<{
          accessToken: string
          refreshToken?: string
          expiresIn: number
        }>
      })
      .then((body) => {
        if (!body) return undefined
        const next: KiroTokenFile = {
          accessToken: body.accessToken,
          refreshToken: body.refreshToken ?? token.refreshToken,
          expiresAt: new Date(Date.now() + body.expiresIn * 1000).toISOString(),
          region: token.region,
          clientId: token.clientId,
          clientSecret: token.clientSecret,
          clientIdHash: token.clientIdHash,
          authMethod: token.authMethod,
          provider: token.provider,
        }
        cache.current = next
        cache.expires = new Date(next.expiresAt).getTime() - BUFFER_MS
        write(next)
        return next.accessToken
      })
      .catch((e: unknown) => {
        console.warn("[kiro-ai-provider]", e instanceof Error ? e.message : e)
        return undefined
      })
  })
}

export function getToken(): Promise<string | undefined> {
  if (process.env.KIRO_API_KEY) return Promise.resolve(process.env.KIRO_API_KEY)
  if (cache.current && Date.now() < cache.expires) return Promise.resolve(cache.current.accessToken)

  return read().then((token) => {
    if (!token) return undefined

    const expiry = new Date(token.expiresAt).getTime()

    if (Date.now() < expiry - BUFFER_MS) {
      cache.current = token
      cache.expires = expiry - BUFFER_MS
      return token.accessToken
    }

    if (!pending.token) {
      pending.token = refresh(token).finally(() => {
        pending.token = undefined
      })
    }
    return pending.token
  })
}

export function hasToken(): Promise<boolean> {
  if (process.env.KIRO_API_KEY) return Promise.resolve(true)
  return access(TOKEN_PATH)
    .then(() => true)
    .catch(() => false)
}

const region: { api: string; token: string } = { api: "", token: "" }

function probe(apiRegion: string, token?: string): Promise<boolean> {
  return (token ? Promise.resolve(token) : getToken()).then((t) => {
    if (!t) return false
    return fetch(`https://q.${validateRegion(apiRegion)}.amazonaws.com/`, {
      method: "POST",
      headers: {
        ...headers(t),
        "X-Amz-Target": "AmazonCodeWhispererService.ListAvailableModels",
      },
      body: JSON.stringify({ origin: "AI_EDITOR" }),
    })
      .then((r) => r.ok)
      .catch(() => false)
  })
}

export function getApiRegion(token?: string): Promise<string> {
  if (region.api && region.token === (token ?? "")) return Promise.resolve(region.api)
  if (pending.region) return pending.region
  pending.region = (token ? Promise.resolve(token) : getToken())
    .catch(() => undefined)
    .then((token) => {
      if (!token) return "us-east-1"
      // API keys work on any region — probe to detect
      return probe("us-east-1", token).then((ok) => {
        if (ok) {
          region.api = "us-east-1"
          region.token = token ?? ""
          return "us-east-1"
        }
        return probe("eu-central-1", token).then((ok2) => {
          if (ok2) {
              region.api = "eu-central-1"
          region.token = token ?? ""
          return "eu-central-1"
          }
          return "us-east-1" // don't cache, try again next time
        })
      })
    })
    .catch(() => "us-east-1")
    .finally(() => {
      pending.region = undefined
    })
  return pending.region
}
