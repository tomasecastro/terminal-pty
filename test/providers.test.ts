import { describe, expect, test } from "bun:test"
import {
  createOpenAICompatibleProvider,
  DEEPINFRA,
  FallbackChain,
  NIM,
  ProviderError,
  type FetchLike,
  type Provider,
} from "../lib/ai/providers"

describe("createOpenAICompatibleProvider", () => {
  test("posts an OpenAI-shaped request and returns the content", async () => {
    let captured: { url: string; init?: RequestInit } | null = null
    const provider = createOpenAICompatibleProvider(
      { id: "nim", baseUrl: NIM.baseUrl, model: NIM.models[0], apiKey: "key-123" },
      async (url, init) => {
        captured = { url, init }
        return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 })
      },
    )

    const text = await provider.chat({ messages: [{ role: "user", content: "hi" }], temperature: 0.2 })

    expect(text).toBe("hello")
    expect(captured?.url).toBe(`${NIM.baseUrl}/chat/completions`)
    const body = JSON.parse(String(captured?.init?.body))
    expect(body).toMatchObject({ model: NIM.models[0], temperature: 0.2, stream: false })
    expect((captured?.init?.headers as Record<string, string>).authorization).toBe("Bearer key-123")
  })

  test("throws a ProviderError with the HTTP status on failure", async () => {
    const provider = createOpenAICompatibleProvider(
      { id: "deepinfra", baseUrl: DEEPINFRA.baseUrl, model: DEEPINFRA.models[0] },
      async () => new Response("boom", { status: 502 }),
    )

    await expect(provider.chat({ messages: [] })).rejects.toBeInstanceOf(ProviderError)
  })

  test("rejects an unexpected payload", async () => {
    const provider = createOpenAICompatibleProvider({ id: "nim", baseUrl: NIM.baseUrl, model: "m" }, async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 }),
    )

    await expect(provider.chat({ messages: [] })).rejects.toBeInstanceOf(ProviderError)
  })

  test("healthCheck reports false when the endpoint is unreachable", async () => {
    const provider = createOpenAICompatibleProvider(
      { id: "local", baseUrl: "http://127.0.0.1:1/v1", model: "m" },
      async () => {
        throw new Error("ECONNREFUSED")
      },
    )

    expect(await provider.healthCheck()).toBe(false)
  })
})

describe("FallbackChain", () => {
  const failing = (id: string): Provider => ({
    id,
    model: "m",
    chat: async () => {
      throw new ProviderError(id, `${id} down`, 500)
    },
    healthCheck: async () => false,
  })

  const working = (id: string): Provider => ({
    id,
    model: "m",
    chat: async () => `${id}-answer`,
    healthCheck: async () => true,
  })

  test("switches to the next provider and reports it", async () => {
    const switches: string[] = []
    const chain = new FallbackChain([failing("nim"), working("deepinfra")], {
      onSwitch: (from, to) => switches.push(`${from}->${to}`),
    })

    const result = await chain.chat({ messages: [] })

    expect(result).toEqual({ text: "deepinfra-answer", providerId: "deepinfra" })
    expect(switches).toEqual(["nim->deepinfra"])
  })

  test("throws the last error when every provider fails", async () => {
    const chain = new FallbackChain([failing("a"), failing("b")])

    await expect(chain.chat({ messages: [] })).rejects.toThrow("b down")
  })

  test("healthCheck maps each provider", async () => {
    const chain = new FallbackChain([failing("a"), working("b")])

    expect(await chain.healthCheck()).toEqual({ a: false, b: true })
  })
})
