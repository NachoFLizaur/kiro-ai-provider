export const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": `aws-sdk-js/1.0.27 ua/2.1 os/${process.platform} lang/js api/codewhispererstreaming#1.0.27 m/E Kiro-ai-provider`,
  "x-amz-user-agent": "aws-sdk-js/1.0.27 Kiro-ai-provider",
  "x-amzn-codewhisperer-optout": "true",
  "x-amzn-kiro-agent-mode": "vibe",
})
