import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ModelRequest } from '../types.js';
import { BaseOpenAIChatAdapter, ModelRequestError } from './base-openai-chat-adapter.js';
import { MeshAdapter } from './mesh-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { OpenRouterAdapter } from './openrouter-adapter.js';
import { MistralAdapter } from './mistral-adapter.js';
import { createModelAdapter } from './create-model-adapter.js';

const STOP_RESPONSE = {
  id: 'chatcmpl-test-1',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant' as const,
        content: 'Hello world',
      },
      finish_reason: 'stop' as const,
    },
  ],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  },
};

const TOOL_CALL_RESPONSE = {
  id: 'chatcmpl-test-2',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            type: 'function' as const,
            function: {
              name: 'lookup',
              arguments: '{"topic":"testing"}',
            },
          },
        ],
      },
      finish_reason: 'tool_calls' as const,
    },
  ],
  usage: {
    prompt_tokens: 20,
    completion_tokens: 10,
    total_tokens: 30,
  },
};

const JSON_OUTPUT_RESPONSE = {
  id: 'chatcmpl-test-3',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant' as const,
        content: '{"result":"structured"}',
      },
      finish_reason: 'stop' as const,
    },
  ],
};

const NO_USAGE_RESPONSE = {
  id: 'chatcmpl-test-4',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant' as const,
        content: 'no usage tracked',
      },
      finish_reason: 'stop' as const,
    },
  ],
};

function simpleRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    messages: [
      { role: 'system', content: 'You are a test assistant.' },
      { role: 'user', content: 'Say hello' },
    ],
    ...overrides,
  };
}

function requestWithTools(): ModelRequest {
  return {
    messages: [{ role: 'user', content: 'Look up testing' }],
    tools: [
      {
        name: 'lookup',
        description: 'Looks up a topic.',
        inputSchema: {
          type: 'object',
          properties: { topic: { type: 'string' } },
          required: ['topic'],
        },
      },
    ],
  };
}

function requestWithToolResult(): ModelRequest {
  return {
    messages: [
      { role: 'user', content: 'Look up testing' },
      { role: 'tool', content: '{"result":"found"}', toolCallId: 'call-1', name: 'lookup' },
    ],
  };
}

function requestWithAssistantToolCalls(): ModelRequest {
  return {
    messages: [
      { role: 'user', content: 'Look up testing' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'lookup',
            input: { topic: 'testing' },
          },
        ],
      },
      { role: 'tool', content: '{"result":"found"}', toolCallId: 'call-1', name: 'lookup' },
    ],
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetchResponse(body: unknown, status = 200) {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe('BaseOpenAIChatAdapter', () => {
  let adapterSequence = 0;

  function createAdapter(overrides?: Partial<ConstructorParameters<typeof BaseOpenAIChatAdapter>[0]>) {
    const model = overrides?.model ?? `test-model-${++adapterSequence}`;

    return new BaseOpenAIChatAdapter({
      provider: 'test',
      model,
      baseUrl: 'https://api.test.com/v1',
      apiKey: 'test-key',
      ...overrides,
    });
  }

  it('sends a basic chat completion request and parses a stop response', async () => {
    const adapter = createAdapter();
    mockFetchResponse(STOP_RESPONSE);

    const result = await adapter.generate(simpleRequest());

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.test.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer test-key');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.model).toBe(adapter.model);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');

    expect(result.text).toBe('Hello world');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      provider: 'test',
      model: adapter.model,
    });
    expect(result.providerResponseId).toBe('chatcmpl-test-1');
  });

  it('maps tool definitions and parses tool call responses', async () => {
    const adapter = createAdapter();
    mockFetchResponse(TOOL_CALL_RESPONSE);

    const result = await adapter.generate(requestWithTools());

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].type).toBe('function');
    expect(body.tools[0].function.name).toBe('lookup');

    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({
      id: 'call-1',
      name: 'lookup',
      input: { topic: 'testing' },
    });
  });

  it('maps tool result messages with tool_call_id', async () => {
    const adapter = createAdapter();
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(requestWithToolResult());

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const toolMsg = body.messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toMatchObject({
      role: 'tool',
      content: '{"result":"found"}',
      tool_call_id: 'call-1',
    });
  });

  it('replays assistant tool call messages in OpenAI format', async () => {
    const adapter = createAdapter();
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(requestWithAssistantToolCalls());

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantMsg).toMatchObject({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'lookup',
            arguments: '{"topic":"testing"}',
          },
        },
      ],
    });
  });

  it('parses structured JSON output from text content', async () => {
    const adapter = createAdapter();
    mockFetchResponse(JSON_OUTPUT_RESPONSE);

    const result = await adapter.generate(simpleRequest());

    expect(result.text).toBe('{"result":"structured"}');
    expect(result.structuredOutput).toEqual({ result: 'structured' });
  });

  it('sends response_format when outputSchema is provided', async () => {
    const adapter = createAdapter();
    mockFetchResponse(STOP_RESPONSE);

    const schema = { type: 'object', properties: { answer: { type: 'string' } } };
    await adapter.generate(simpleRequest({ outputSchema: schema }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        name: 'response',
        strict: true,
        schema,
      },
    });
  });

  it('returns undefined usage when provider omits it', async () => {
    const adapter = createAdapter();
    mockFetchResponse(NO_USAGE_RESPONSE);

    const result = await adapter.generate(simpleRequest());

    expect(result.usage).toBeUndefined();
    expect(result.text).toBe('no usage tracked');
  });

  it('retries 429 responses with jitter before succeeding', async () => {
    const adapter = createAdapter();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    fetchSpy
      .mockResolvedValueOnce(
        new Response('{"error":"rate limited"}', {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(STOP_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const resultPromise = adapter.generate(simpleRequest());

    await vi.advanceTimersByTimeAsync(249);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    const result = await resultPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('Hello world');
  });

  it('honors Retry-After before retrying', async () => {
    const adapter = createAdapter();
    vi.useFakeTimers();

    fetchSpy
      .mockResolvedValueOnce(
        new Response('{"error":"rate limited"}', {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '2',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(STOP_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const resultPromise = adapter.generate(simpleRequest());

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    await resultPromise;

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('shares provider/model cooldown across adapter instances', async () => {
    const firstAdapter = createAdapter({ model: 'shared-cooldown-model' });
    const secondAdapter = createAdapter({ model: 'shared-cooldown-model' });

    vi.useFakeTimers();

    fetchSpy
      .mockResolvedValueOnce(
        new Response('{"error":"rate limited"}', {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '2',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(STOP_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(STOP_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const firstPromise = firstAdapter.generate(simpleRequest());
    await vi.advanceTimersByTimeAsync(0);

    const secondPromise = secondAdapter.generate(simpleRequest());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([firstPromise, secondPromise]);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('allows concurrent requests for the same provider and model up to the configured gate limit', async () => {
    const firstAdapter = createAdapter({ model: 'shared-model', maxConcurrentRequests: 2 });
    const secondAdapter = createAdapter({ model: 'shared-model', maxConcurrentRequests: 2 });
    const firstResponse = deferred<Response>();

    fetchSpy
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(STOP_RESPONSE), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const firstPromise = firstAdapter.generate(simpleRequest());
    await Promise.resolve();

    const secondPromise = secondAdapter.generate(simpleRequest());
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    firstResponse.resolve(
      new Response(JSON.stringify(STOP_RESPONSE), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await Promise.all([firstPromise, secondPromise]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('stops waiting for a retry when the request signal aborts', async () => {
    const adapter = createAdapter();
    const controller = new AbortController();
    const aborted = new Error('stop waiting');

    vi.useFakeTimers();
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '2',
        },
      }),
    );

    const resultPromise = adapter.generate(simpleRequest({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(aborted);

    await expect(resultPromise).rejects.toBe(aborted);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('throws ModelRequestError on non-retryable HTTP status', async () => {
    const adapter = createAdapter();
    fetchSpy.mockResolvedValueOnce(
      new Response('{"error":"bad request"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const error = await adapter.generate(simpleRequest()).catch((e) => e);
    expect(error).toBeInstanceOf(ModelRequestError);
    expect(error.statusCode).toBe(400);
  });

  it('strips trailing slashes from baseUrl', async () => {
    const adapter = createAdapter({ baseUrl: 'https://api.test.com/v1///' });
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(simpleRequest());

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.test.com/v1/chat/completions');
  });

  it('omits Authorization header when no apiKey is provided', async () => {
    const adapter = createAdapter({ apiKey: undefined });
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(simpleRequest());

    expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBeUndefined();
  });

  it('does not send tools array when tools list is empty', async () => {
    const adapter = createAdapter();
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(simpleRequest({ tools: [] }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it('handles malformed tool arguments gracefully', async () => {
    const adapter = createAdapter();
    mockFetchResponse({
      id: 'chatcmpl-bad-args',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-bad',
                type: 'function',
                function: {
                  name: 'lookup',
                  arguments: 'not-valid-json',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    const result = await adapter.generate(requestWithTools());

    expect(result.toolCalls![0].input).toBe('not-valid-json');
  });
});

describe('OpenRouterAdapter', () => {
  it('sends OpenRouter-specific headers', async () => {
    const adapter = new OpenRouterAdapter({
      model: 'anthropic/claude-sonnet-4',
      apiKey: 'or-key',
      siteUrl: 'https://my-app.com',
      siteName: 'My App',
    });
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(simpleRequest());

    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer or-key');
    expect(headers['HTTP-Referer']).toBe('https://my-app.com');
    expect(headers['X-Title']).toBe('My App');
    expect(adapter.provider).toBe('openrouter');
  });

  it('uses OpenRouter base URL by default', async () => {
    const adapter = new OpenRouterAdapter({
      model: 'meta-llama/llama-3.1-8b-instruct',
      apiKey: 'or-key',
    });
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(simpleRequest());

    expect(fetchSpy.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
  });
});

describe('OllamaAdapter', () => {
  it('uses localhost URL and no auth by default', async () => {
    const adapter = new OllamaAdapter({ model: 'llama3.2' });
    mockFetchResponse(NO_USAGE_RESPONSE);

    await adapter.generate(simpleRequest());

    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:11434/v1/chat/completions');
    expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBeUndefined();
    expect(adapter.provider).toBe('ollama');
    expect(adapter.capabilities.usage).toBe(false);
  });

  it('allows custom baseUrl', async () => {
    const adapter = new OllamaAdapter({ model: 'llama3.2', baseUrl: 'http://gpu-box:11434/v1' });
    mockFetchResponse(NO_USAGE_RESPONSE);

    await adapter.generate(simpleRequest());

    expect(fetchSpy.mock.calls[0][0]).toBe('http://gpu-box:11434/v1/chat/completions');
  });
});

describe('MistralAdapter', () => {
  it('uses Mistral base URL and auth', async () => {
    const adapter = new MistralAdapter({ model: 'mistral-large-latest', apiKey: 'ms-key' });
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(simpleRequest());

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer ms-key');
    expect(adapter.provider).toBe('mistral');
    expect(adapter.capabilities.usage).toBe(true);
  });
});

describe('MeshAdapter', () => {
  it('uses Mesh base URL and auth', async () => {
    const adapter = new MeshAdapter({ model: 'openai/gpt-4o', apiKey: 'mesh-key' });
    mockFetchResponse(STOP_RESPONSE);

    await adapter.generate(simpleRequest());

    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.meshapi.ai/v1/chat/completions');
    expect(fetchSpy.mock.calls[0][1].headers['Authorization']).toBe('Bearer mesh-key');
    expect(adapter.provider).toBe('mesh');
    expect(adapter.capabilities.usage).toBe(true);
  });
});

describe('createModelAdapter', () => {
  it('creates an OpenRouterAdapter', () => {
    const adapter = createModelAdapter({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      apiKey: 'key',
    });
    expect(adapter.provider).toBe('openrouter');
    expect(adapter.model).toBe('anthropic/claude-sonnet-4');
  });

  it('creates an OllamaAdapter', () => {
    const adapter = createModelAdapter({ provider: 'ollama', model: 'llama3.2' });
    expect(adapter.provider).toBe('ollama');
    expect(adapter.model).toBe('llama3.2');
  });

  it('creates a MistralAdapter', () => {
    const adapter = createModelAdapter({
      provider: 'mistral',
      model: 'mistral-large-latest',
      apiKey: 'key',
    });
    expect(adapter.provider).toBe('mistral');
    expect(adapter.model).toBe('mistral-large-latest');
  });

  it('creates a MeshAdapter', () => {
    const adapter = createModelAdapter({
      provider: 'mesh',
      model: 'openai/gpt-4o',
      apiKey: 'key',
    });
    expect(adapter.provider).toBe('mesh');
    expect(adapter.model).toBe('openai/gpt-4o');
  });

  it('throws when OpenRouter is missing apiKey', () => {
    expect(() => createModelAdapter({ provider: 'openrouter', model: 'x' })).toThrow('apiKey');
  });

  it('throws when Mistral is missing apiKey', () => {
    expect(() => createModelAdapter({ provider: 'mistral', model: 'x' })).toThrow('apiKey');
  });

  it('throws when Mesh is missing apiKey', () => {
    expect(() => createModelAdapter({ provider: 'mesh', model: 'x' })).toThrow('apiKey');
  });

  it('throws on unknown provider', () => {
    expect(() =>
      createModelAdapter({ provider: 'nope' as 'ollama', model: 'x' }),
    ).toThrow('Unknown provider');
  });
});
