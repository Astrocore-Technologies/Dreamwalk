/** HTTPS transport for hosting plans that block SMTP. Acceptance is not delivery. */
export async function sendBrevoMessage(
  apiKey: string,
  message: { from: string; to: string; subject: string; text: string; link?: string },
  fetcher: typeof fetch = fetch,
) {
  try {
    const escape = (text: string) =>
      text.replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
      );
    const response = await fetcher('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'api-key': apiKey,
      },
      body: JSON.stringify({
        sender: { email: message.from, name: 'Dreamwalk' },
        to: [{ email: message.to }],
        subject: message.subject,
        textContent: message.text,
        htmlContent: `<pre>${escape(message.text)}</pre>${message.link ? `<p><a href="${escape(message.link)}">${escape(message.subject)}</a></p>` : ''}`,
      }),
    });
    await response.body?.cancel();
    if (response.status !== 201) throw new Error('EMAIL_DELIVERY_FAILED');
  } catch {
    // Provider errors may contain recipient addresses or token-bearing message content.
    // No provider body, key, request or raw error is exposed or logged.
    throw new Error('EMAIL_DELIVERY_FAILED');
  }
}
