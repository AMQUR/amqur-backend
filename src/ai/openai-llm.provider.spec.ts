import { OpenAiLlmProvider } from './openai-llm.provider';

const cfg = (env: Record<string, string>) => ({ get: (k: string) => env[k] });
const sse = (frames: unknown[]) => {
  const text =
    frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') +
    'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(text);
  // deliberately split mid-frame to exercise buffering
  const parts = [bytes.slice(0, 37), bytes.slice(37, 120), bytes.slice(120)];
  return {
    ok: true,
    body: (async function* () {
      for (const p of parts) yield p;
    })(),
  };
};

describe('OpenAiLlmProvider', () => {
  const prev = global.fetch;
  afterEach(() => {
    global.fetch = prev;
  });
  const make = (extra: Record<string, string> = { OPENAI_TOOLS_API: 'chat' }) =>
    new OpenAiLlmProvider(
      cfg({
        OPENAI_API_KEY: 'k',
        OPENAI_MODEL: 'default-model',
        ...extra,
      }) as never,
    );

  it('uses the Responses endpoint for tool calls on api.openai.com: stream, call, result, answer', async () => {
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    let n = 0;
    global.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      n += 1;
      const call = {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_9',
        name: 'calculate',
        arguments: '{"expression":"17% of 42500"}',
      };
      return n === 1
        ? sse([
            { type: 'response.output_text.delta', delta: 'Working on it. ' },
            {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [call],
                usage: { input_tokens: 50, output_tokens: 9 },
              },
            },
          ])
        : sse([
            { type: 'response.output_text.delta', delta: '17% of $42,500 ' },
            { type: 'response.output_text.delta', delta: 'is $7,225.' },
            {
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [
                      {
                        type: 'output_text',
                        text: '17% of $42,500 is $7,225.',
                      },
                    ],
                  },
                ],
                usage: { input_tokens: 80, output_tokens: 12 },
              },
            },
          ]);
    }) as never;
    const events: Array<[string, boolean | undefined]> = [];
    const run = jest.fn(async () => '{"result":"7225"}');
    const out = await make({}).generate({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: '17% of $42,500?' },
      ],
      localTools: [
        {
          name: 'calculate',
          description: 'd',
          inputSchema: { type: 'object' },
          run,
        },
      ],
      onTextDelta: (d, reset) => events.push([d, reset]),
    });
    expect(seen[0].url).toBe('https://api.openai.com/v1/responses');
    expect(seen[0].body).toMatchObject({
      instructions: 'sys',
      stream: true,
      store: false,
      tools: [{ type: 'function', name: 'calculate' }],
    });
    expect(run).toHaveBeenCalledWith({ expression: '17% of 42500' });
    const second = seen[1].body.input as Array<Record<string, unknown>>;
    expect(second.at(-2)).toMatchObject({
      type: 'function_call',
      call_id: 'call_9',
    });
    expect(second.at(-1)).toEqual({
      type: 'function_call_output',
      call_id: 'call_9',
      output: '{"result":"7225"}',
    });
    expect(out).toMatchObject({
      text: '17% of $42,500 is $7,225.',
      toolsUsed: ['calculate'],
      inputTokens: 130,
      outputTokens: 21,
    });
    // narration before the tool call was retracted, then the real answer streamed
    expect(events).toContainEqual(['', true]);
    expect(
      events
        .filter((e) => !e[1])
        .map((e) => e[0])
        .join(''),
    ).toBe('Working on it. 17% of $42,500 is $7,225.');
  });

  it('streams text deltas and reports usage', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    global.fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sse([
        { choices: [{ delta: { content: 'Islam' } }] },
        { choices: [{ delta: { content: 'abad.' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
      ]);
    }) as never;
    const deltas: string[] = [];
    const out = await make().generate({
      system: 'sys',
      messages: [{ role: 'user', content: 'capital of Pakistan?' }],
      model: 'tier-model',
      onTextDelta: (d) => deltas.push(d),
    });
    expect(deltas.join('')).toBe('Islamabad.');
    expect(out).toMatchObject({
      text: 'Islamabad.',
      provider: 'openai',
      model: 'tier-model',
      inputTokens: 11,
      outputTokens: 3,
      stopReason: 'stop',
    });
    expect(bodies[0]).toMatchObject({ model: 'tier-model', stream: true });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
    expect(bodies[0]).not.toHaveProperty('temperature');
  });

  it('runs local tools, feeds results back, and drops narration written before the call', async () => {
    const bodies: Array<{
      messages: Array<Record<string, unknown>>;
      tools?: unknown[];
    }> = [];
    let n = 0;
    global.fetch = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      n += 1;
      return n === 1
        ? sse([
            { choices: [{ delta: { content: 'Let me calculate. ' } }] },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        function: { name: 'calculate', arguments: '{"expr' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: 'ession":"17% of 42500"}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ])
        : sse([
            {
              choices: [
                { delta: { content: 'It is $7,225.' }, finish_reason: 'stop' },
              ],
            },
          ]);
    }) as never;
    const events: Array<[string, boolean | undefined]> = [];
    const run = jest.fn(() => '{"result":"7225"}');
    const out = await make().generate({
      messages: [{ role: 'user', content: '17% of $42,500?' }],
      localTools: [
        {
          name: 'calculate',
          description: 'd',
          inputSchema: { type: 'object' },
          run,
        },
      ],
      onTextDelta: (d, reset) => events.push([d, reset]),
    });
    expect(run).toHaveBeenCalledWith({ expression: '17% of 42500' });
    expect(out.text).toBe('It is $7,225.');
    expect(out.toolsUsed).toEqual(['calculate']);
    expect(events).toContainEqual(['', true]);
    expect(bodies[0].tools).toHaveLength(1);
    const second = bodies[1].messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant' });
    expect(second.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '{"result":"7225"}',
    });
  });

  it('answers a tool call with an error result when arguments are not JSON or the tool throws', async () => {
    let n = 0;
    const seen: Array<{ messages: Array<Record<string, unknown>> }> = [];
    global.fetch = (async (_u: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)));
      n += 1;
      return {
        ok: true,
        json: async () =>
          n === 1
            ? {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      content: null,
                      tool_calls: [
                        {
                          id: 'c1',
                          function: {
                            name: 'calculate',
                            arguments: '{not json',
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : {
                choices: [
                  {
                    finish_reason: 'stop',
                    message: { content: 'Sorry, try again.' },
                  },
                ],
              },
      };
    }) as never;
    const out = await make().generate({
      messages: [{ role: 'user', content: 'x' }],
      localTools: [
        {
          name: 'calculate',
          description: 'd',
          inputSchema: {},
          run: () => 'never',
        },
      ],
    });
    expect(out.text).toBe('Sorry, try again.');
    expect(String(seen[1].messages.at(-1)?.content)).toMatch(/^Error:/);
  });

  it('throws on HTTP errors and on an empty completion, without logging a body', async () => {
    global.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => 'secret',
    })) as never;
    await expect(
      make().generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow('OpenAI HTTP 429');
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    })) as never;
    await expect(
      make().generate({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow('empty completion');
  });
});
