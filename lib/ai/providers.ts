/**
 * Provider abstraction for the assistant panel.
 *
 * Everything speaks the OpenAI chat-completions wire format, which is what NVIDIA NIM,
 * DeepInfra and a local OpenCode server all expose. No SDK is pulled in: one `fetch` and a
 * narrow response guard is enough, and it keeps the package dependency-free.
 */

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

export interface ChatRequest {
  readonly messages: readonly ChatMessage[]
  readonly temperature?: number
  readonly maxTokens?: number
  readonly signal?: AbortSignal
}

export interface ProviderConfig {
  readonly id: string
  readonly label?: string
  readonly baseUrl: string
  readonly model: string
  readonly apiKey?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
}

export interface Provider {
  readonly id: string
  readonly model: string
  chat(request: ChatRequest): Promise<string>
  healthCheck(): Promise<boolean>
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class ProviderError extends Error {
  readonly providerId: string
  readonly status: number | undefined
  readonly body: string

  constructor(providerId: string, message: string, status?: number, body = "") {
    super(message)
    this.name = "ProviderError"
    this.providerId = providerId
    this.status = status
    this.body = body
  }
}

/** Well-known endpoints. Models are suggestions; any id the provider accepts works. */
export const NIM = {
  baseUrl: "https://integrate.api.nvidia.com/v1",
  models: ["meta/llama-3.1-70b-instruct", "nvidia/nemotron-3-ultra"],
} as const

export const DEEPINFRA = {
  baseUrl: "https://api.deepinfra.com/v1/openai",
  models: ["meta-llama/Meta-Llama-3.1-70B-Instruct", "mistralai/Mixtral-8x7B-Instruct-v0.1"],
} as const

export const LOCAL = {
  baseUrl: "http://127.0.0.1:4096/v1",
  models: ["opencode/local"],
} as const

export function createOpenAICompatibleProvider(
  config: ProviderConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Provider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const modelsEndpoint = `${config.baseUrl.replace(/\/+$/, "")}/models`

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    ...config.headers,
  }

  return {
    id: config.id,
    model: config.model,
    async chat(request) {
      const signal = request.signal ?? timeoutSignal(config.timeoutMs)
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          model: config.model,
          messages: request.messages,
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          stream: false,
        }),
      })

      if (!response.ok) {
        const body = await safeText(response)
        throw new ProviderError(config.id, `${config.id} responded ${response.status}`, response.status, body)
      }

      const payload = (await response.json()) as unknown
      const content = readContent(payload)
      if (content === null) throw new ProviderError(config.id, `${config.id} returned an unexpected payload`)
      return content
    },
    async healthCheck() {
      try {
        const response = await fetchImpl(modelsEndpoint, { headers, signal: timeoutSignal(config.timeoutMs) })
        return response.ok
      } catch {
        return false
      }
    },
  }
}

function timeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (timeoutMs === undefined) return undefined
  return AbortSignal.timeout(timeoutMs)
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ""
  }
}

function readContent(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0] as { message?: { content?: unknown } }
  const content = first.message?.content
  return typeof content === "string" ? content : null
}

export interface FallbackChainOptions {
  readonly onSwitch?: (from: string, to: string, error: unknown) => void
}

export interface FallbackResult {
  readonly text: string
  readonly providerId: string
}

/** Tries each provider in order, reporting the switch so the UI can show a warning. */
export class FallbackChain {
  readonly #providers: readonly Provider[]
  readonly #onSwitch: FallbackChainOptions["onSwitch"]

  constructor(providers: readonly Provider[], options: FallbackChainOptions = {}) {
    this.#providers = providers
    this.#onSwitch = options.onSwitch
  }

  get providers(): readonly Provider[] {
    return this.#providers
  }

  async chat(request: ChatRequest): Promise<FallbackResult> {
    let lastError: unknown = new Error("No providers configured")

    for (let index = 0; index < this.#providers.length; index += 1) {
      const provider = this.#providers[index]
      if (!provider) continue
      try {
        return { text: await provider.chat(request), providerId: provider.id }
      } catch (error) {
        lastError = error
        const next = this.#providers[index + 1]
        if (next) this.#onSwitch?.(provider.id, next.id, error)
      }
    }

    throw lastError
  }

  async healthCheck(): Promise<Record<string, boolean>> {
    const entries = await Promise.all(
      this.#providers.map(async (provider) => [provider.id, await provider.healthCheck()] as const),
    )
    return Object.fromEntries(entries)
  }
}
