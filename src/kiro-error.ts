export class KiroAuthError extends Error {
  readonly name = "KiroAuthError" as const
  constructor(readonly data: { message: string }) {
    super(data.message)
  }
}

export class KiroApiError extends Error {
  readonly name = "KiroApiError" as const
  constructor(readonly data: { status: number; body: string }) {
    super(`Kiro API error ${data.status}: ${data.body}`)
  }
}

export class KiroStreamError extends Error {
  readonly name = "KiroStreamError" as const
  constructor(readonly data: { message: string }) {
    super(data.message)
  }
}
