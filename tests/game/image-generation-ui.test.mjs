import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) =>
  readFile(new URL('../../apps/web/components/assets/' + path, import.meta.url), 'utf8');
test('generation UI gates the selected mode with fresh quote consent and stable retry identity', async () => {
  const s = await read('image-generation.tsx');
  assert.match(s, /externalOnly \? 'external' : 'mock'/);
  assert.match(s, /externalDispatchAllowed/);
  assert.match(s, /studioSourceHash === preparedRequest.studioLocationContext.sourceHash/);
  assert.match(s, /readOnly=\{!!preparedRequest\}/);
  assert.match(s, /result.quote\?\.mode === mode/);
  assert.match(s, /config.data\?\.verifiedUpperMicros/);
  assert.match(s, /!config.data\?\.externalEnabled \|\| !authorizationId/);
  assert.match(s, /result.quote.upperMicros === 0/);
  assert.match(s, /confirmedQuoteId !== quote\?\.id/);
  assert.match(s, /<ImageConfirmation/);
  assert.match(s, /actionLock\.current/);
  assert.match(s, /!imageFramingEvidenceMatches\(preparedRequest \?\? \{\}, quote\)/);
  assert.match(s, /quotedFingerprint.current !== fingerprint/);
  assert.match(s, /quote\?\.mode !== mode/);
  assert.match(s, /quote.upperMicros === null/);
  assert.match(s, /estimatePending/);
  assert.doesNotMatch(s, /setConsent|setEstimateRiskConsent/);
  assert.match(s, /onConfirm=\{\(\) => void run\(quote.id\)\}/);
  assert.match(s, /operation.current.id/);
  assert.match(s, /declineReuse: true/);
  assert.match(s, /revision.owned/);
  assert.match(s, /Math.min\(\s*2,/);
  assert.match(s, /references.length <= referenceLimit/);
  assert.doesNotMatch(s, /setAllowReuse|setLicense|setAttribution/);
  assert.doesNotMatch(s, /api.openai|Authorization:|apiKey|process.env/);
});
test('job result cannot silently publish or bind and external unavailable copy has all locales', async () => {
  const s = await read('image-generation.tsx');
  assert.doesNotMatch(s, /\/submit|playable-versions|method: 'PUT'/);
  assert.match(s, /onSelect\(revision\)/);
  assert.match(s, /job.status === 'admitted'/);
  const labels = await read('image-messages.ts');
  for (const marker of [
    'Внешняя генерация недоступна',
    'External generation is unavailable',
    'Зовнішня генерація недоступна',
  ])
    assert.ok(labels.includes(marker));
});

test('image confirmation is one explicit action; inline maps never auto-quote from a checkbox', async () => {
  const confirmation = await read('image-confirmation.tsx');
  assert.doesNotMatch(confirmation, /type="checkbox"|useEffect|api\(/);
  assert.match(confirmation, /onClick=\{onConfirm\}/);
  assert.match(confirmation, /onClick=\{onCancel\}/);
  assert.match(confirmation, /confirmRisk/);
  assert.match(confirmation, /walletCharging \? 'confirmNotice' : 'confirmProviderNotice'/);
  assert.match(confirmation, /walletCharging \? 'confirmRisk' : 'confirmProviderRisk'/);
  const inline = await readFile(
    new URL(
      '../../apps/web/components/visual-authoring/location-image-inline.tsx',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(inline, /async function prepareQuote\(\)/);
  assert.match(inline, /onClick=\{\(\) => void prepareQuote\(\)\}/);
  assert.doesNotMatch(inline, /setAttested|setTimeout/);
  assert.match(inline, /confirmedQuoteId !== quote\?\.quote.id/);
  assert.match(inline, /imageFramingEvidenceMatches/);
  assert.match(inline, /reserve > generationRemaining/);
  assert.match(inline, /cancelledQuotes.current.has\(confirmedQuoteId\)/);
  assert.match(inline, /quote.key !== currentKey.current/);
  for (const path of ['location-image.tsx', 'location-image-inline.tsx']) {
    const selection = await readFile(
      new URL('../../apps/web/components/visual-authoring/' + path, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(selection, /checked=\{reviewed\}/);
    assert.match(selection, /sourceHash !==/);
    assert.match(selection, /onClick=\{\(\) => void bind\(\)\}/);
  }
  const generic = await read('image-generation.tsx');
  assert.match(generic, /title: title.trim\(\) \|\| prompt.trim\(\).slice\(0, 120\)/);
  assert.doesNotMatch(
    generic,
    /g\('advanced'\)|g\('quoteRights'\)|RequestReserve|defaultImageStylePrompt/,
  );
  assert.match(generic, /ImageQuotePrice/);
  assert.match(generic, /!preparedRequest &&/);
});

test('actual confirmation distinguishes wallet holds from provider billing in every locale', async () => {
  const { transformSync } = await import('esbuild');
  const jsx = (type, props) => ({ type, props });
  const compile = async (file, dependencies) => {
    const module = { exports: {} };
    const code = transformSync(await read(file), {
      loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
      format: 'cjs',
      jsx: 'automatic',
    }).code;
    new Function('require', 'module', 'exports', code)(
      (name) => {
        assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
        return dependencies[name];
      },
      module,
      module.exports,
    );
    return module.exports;
  };
  const text = (node) =>
    node == null
      ? ''
      : Array.isArray(node)
        ? node.map(text).join(' ')
        : typeof node === 'object'
          ? text(node.props?.children)
          : String(node);
  for (const locale of ['ru', 'en', 'uk']) {
    const labels = await compile('image-messages.ts', {
      '@/lib/i18n': { useT: () => ({ locale }) },
    });
    const { ImageConfirmation } = await compile('image-confirmation.tsx', {
      'react/jsx-runtime': { jsx, jsxs: jsx },
      '../ui': { Button: 'button' },
      './image-messages': labels,
    });
    const wallet = text(ImageConfirmation({ estimated: true, walletCharging: true }));
    const provider = text(ImageConfirmation({ estimated: true, walletCharging: false }));
    assert.match(
      provider,
      locale === 'en'
        ? /provider invoice/
        : locale === 'ru'
          ? /счёт провайдера/
          : /рахунок провайдера/,
    );
    assert.doesNotMatch(provider, /Dreams first|сначала Грёзы|спочатку Мрії/);
    assert.match(
      wallet,
      locale === 'en' ? /wallet charge/ : locale === 'ru' ? /из кошелька/ : /з гаманця/,
    );
    assert.notEqual(wallet, provider);
  }
});
