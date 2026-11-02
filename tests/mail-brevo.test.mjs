import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sendBrevoMessage } = require('../apps/api/dist/mail-brevo.js');
const message = {
  from: 'sender@example.test',
  to: 'recipient@example.test',
  subject: 'Verify',
  link: 'https://example.test/#token=synthetic',
  text: '<test>\nhttps://example.test/#token=synthetic',
};
test('Brevo transport sends exactly one HTTPS request and considers201 only acceptance', async () => {
  let count = 0;
  await sendBrevoMessage('synthetic-key', message, async (url, options) => {
    count++;
    assert.equal(url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['api-key'], 'synthetic-key');
    assert.ok(options.signal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.to, [{ email: message.to }]);
    assert.equal(body.textContent, message.text);
    assert.ok(body.htmlContent.includes('&lt;test&gt;'));
    assert.ok(!body.htmlContent.includes('<test>'));
    assert.ok(
      body.htmlContent.includes('<a href="https://example.test/#token=synthetic">Verify</a>'),
    );
    return new Response('{}', { status: 201 });
  });
  assert.equal(count, 1);
});
test('Brevo failures are sanitized and never retried', async () => {
  for (const status of [200, 400, 401, 429, 500]) {
    let calls = 0;
    await assert.rejects(
      sendBrevoMessage('synthetic-key', message, async () => {
        calls++;
        return new Response('secret recipient token', { status });
      }),
      { message: 'EMAIL_DELIVERY_FAILED' },
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    sendBrevoMessage('synthetic-key', message, async () => {
      throw new Error('secret');
    }),
    { message: 'EMAIL_DELIVERY_FAILED' },
  );
});
