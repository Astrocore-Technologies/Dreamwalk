/** Test-only transport. No HTTPS request can leave this disposable API process. */
import { readFileSync, writeFileSync } from 'node:fs';
import { spatialFixture } from './spatial-fixtures.mjs';
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SPATIAL_HTTP_TEST_TRANSPORT !== 'true' ||
  process.env.NPC_AI_API_KEY !== 'synthetic-only-no-network'
)
  throw new Error('SYNTHETIC_TRANSPORT_ONLY');
const output = process.env.SPATIAL_HTTP_CALLS_FILE;
if (!output) throw new Error('SYNTHETIC_TRACE_REQUIRED');
const original = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://api.openai.com/v1/responses') {
    const body = JSON.parse(init.body);
    if (
      body.model !== 'gpt-6-luna' ||
      body.text?.format?.name !== 'private_location_layout' ||
      body.store !== false ||
      body.stream !== false ||
      body.max_output_tokens !== 2048 ||
      init.redirect !== 'error' ||
      body.tools
    )
      throw new Error('UNEXPECTED_SYNTHETIC_ENVELOPE');
    const context = JSON.parse(body.input);
    if (
      !context.brief?.description?.includes('HTTP_GREENHOUSE') ||
      JSON.stringify(context).includes('PRIVATE_SPATIAL_CANARY')
    )
      throw new Error('UNSAFE_SYNTHETIC_CONTEXT');
    const calls = JSON.parse(readFileSync(output, 'utf8'));
    calls.push({
      model: body.model,
      purpose: body.text.format.name,
      briefName: context.brief.name,
    });
    writeFileSync(output, JSON.stringify(calls));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response(
      JSON.stringify({
        id: 'response-synthetic-spatial-' + calls.length,
        status: 'completed',
        service_tier: 'default',
        usage: { input_tokens: 100, output_tokens: 400 },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(spatialFixture('greenhouse')) }],
          },
        ],
      }),
      { headers: { 'content-type': 'application/json', 'x-request-id': 'synthetic-spatial-http' } },
    );
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname))
    throw new Error('TEST_EXTERNAL_TRANSPORT_FORBIDDEN');
  return original(input, init);
};
