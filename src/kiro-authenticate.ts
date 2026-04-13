import path from "path"
import os from "os"
import { TOKEN_PATH } from "./kiro-auth"

const BUILDER_ID_URL = "https://view.awsapps.com/start"
const CLIENT_PATH = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-client-registration.json")
const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
]
const GRANT_TYPES = ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
const POLLING_MARGIN_MS = 3000
const USER_AGENT = "kiro-ai-provider/0.0.1"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function mkdir(dir: string): Promise<void> {
  return import("fs/promises")
    .then((fs) => fs.mkdir(dir, { recursive: true }).then(() => {}))
    .catch(() => {})
}

function write(filepath: string, data: unknown): Promise<void> {
  return Bun.write(filepath, JSON.stringify(data, null, 2))
    .then(() => {})
    .catch(() => {})
}

export async function authenticate(options?: {
  startUrl?: string
  region?: string
  onVerification?: (url: string, code: string) => void
}): Promise<{ accessToken: string; refreshToken: string; region: string }> {
  const url = options?.startUrl ?? BUILDER_ID_URL
  const region = options?.region ?? "us-east-1"
  const oidc = `https://oidc.${region}.amazonaws.com`

  const registration = await fetch(`${oidc}/client/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      clientName: "kiro-ai-provider",
      clientType: "public",
      scopes: SCOPES,
      grantTypes: GRANT_TYPES,
      issuerUrl: url,
    }),
  })

  if (!registration.ok) throw new Error("Failed to register OIDC client")

  const client = (await registration.json()) as {
    clientId: string
    clientSecret: string
    clientIdIssuedAt: number
    clientSecretExpiresAt: number
  }

  const device = await fetch(`${oidc}/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl: url,
    }),
  })

  if (!device.ok) throw new Error("Failed to start device authorization")

  const auth = (await device.json()) as {
    verificationUri: string
    verificationUriComplete: string
    userCode: string
    deviceCode: string
    interval: number
    expiresIn: number
  }

  options?.onVerification?.(auth.verificationUriComplete, auth.userCode)

  const delay = { ms: auth.interval }

  while (true) {
    const response = await fetch(`${oidc}/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        grantType: DEVICE_GRANT,
        deviceCode: auth.deviceCode,
      }),
    })

    if (response.ok) {
      const tokens = (await response.json()) as {
        accessToken: string
        refreshToken: string
        expiresIn: number
        tokenType: string
      }

      const expires = new Date(Date.now() + tokens.expiresIn * 1000)

      await mkdir(path.dirname(TOKEN_PATH))

      await write(TOKEN_PATH, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: expires.toISOString(),
        region,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
      })

      await write(CLIENT_PATH, {
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        clientIdIssuedAt: client.clientIdIssuedAt,
        clientSecretExpiresAt: client.clientSecretExpiresAt,
      })

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        region,
      }
    }

    const error = (await response.json().catch(() => ({}))) as {
      error?: string
      error_description?: string
    }

    if (error.error === "authorization_pending") {
      await sleep(delay.ms * 1000 + POLLING_MARGIN_MS)
      continue
    }

    if (error.error === "slow_down") {
      delay.ms = delay.ms + 5
      await sleep(delay.ms * 1000 + POLLING_MARGIN_MS)
      continue
    }

    if (error.error) throw new Error(`Authentication failed: ${error.error_description ?? error.error}`)

    await sleep(delay.ms * 1000 + POLLING_MARGIN_MS)
  }
}
