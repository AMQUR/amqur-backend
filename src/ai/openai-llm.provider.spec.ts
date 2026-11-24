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
  const make = () =>
    new OpenAiLlmProvider(
      cfg({ OPENAI_API_KEY: 'k', OPENAI_MODEL: 'default-model' }) as never,
    );

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
