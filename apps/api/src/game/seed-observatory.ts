/** First-party editorial fixture only. Never upgrades an edited story, draft or existing save. */
import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { compilePlayableDraft, createCompleteObservatoryDraft } from '@dreamwalk/game-core';
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export async function seedCompleteObservatory(
  db: Pool,
  ownerId: string,
  expected: { title: string; synopsis: string; world: string; locations: unknown[] },
) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const owner = (
      await c.query(
        "SELECT id FROM users WHERE id=$1 AND email='editorial@dreamwalk.invalid' AND password_hash='disabled' AND deleted_at IS NULL FOR SHARE",
        [ownerId],
      )
    ).rows[0];
    if (!owner) {
      await c.query('ROLLBACK');
      return;
    }
    const row = (
      await c.query(
        "SELECT * FROM adventures WHERE owner_id=$1 AND slug='old-observatory' FOR UPDATE",
        [ownerId],
      )
    ).rows[0];
    if (
      !row ||
      row.status !== 'published' ||
      row.visibility !== 'public' ||
      row.title !== expected.title ||
      row.synopsis !== expected.synopsis ||
      row.data.sourceRevision !== 1 ||
      row.data.content?.world !== expected.world ||
      !isDeepStrictEqual(row.data.content?.locations, expected.locations) ||
      row.data.content?.rules !==
        'Исследуйте, задавайте вопросы и уважайте решения других. Игровой режим появится позже.' ||
      row.published_snapshot?.playableVersionId ||
      (
        await c.query(
          'SELECT 1 FROM adventure_game_drafts WHERE adventure_id=$1 UNION ALL SELECT 1 FROM game_playable_versions WHERE adventure_id=$1',
          [row.id],
        )
      ).rowCount
    ) {
      await c.query('ROLLBACK');
      return;
    }
    const npcIds = row.data.content?.npcIds ?? [];
    const definitions = (
      await c.query(
        'SELECT id,data FROM npcs WHERE owner_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
        [ownerId, npcIds],
      )
    ).rows;
    const keeper = definitions.find((n) => n.data.name === 'Элиас' && n.data.role === 'Смотритель');
    if (
      !keeper ||
      definitions.length !== 3 ||
      definitions.some(
        (n) =>
          Number(n.data.sourceRevision ?? 1) !== 1 ||
          !['Элиас', 'Мира', 'Тик'].includes(n.data.name),
      )
    ) {
      await c.query('ROLLBACK');
      return;
    }
    const draft = createCompleteObservatoryDraft();
    draft.title = expected.title;
    draft.npcs.find((n) => n.id === 'keeper')!.sourceNpcId = keeper.id;
    draft.npcs.find((n) => n.id === 'keeper')!.label = keeper.data.name;
    const keeperDraft = draft.npcs.find((n) => n.id === 'keeper')!;
    delete keeperDraft.labelTranslations;
    const names: Partial<Record<'ru' | 'en' | 'uk', string>> = {};
    for (const locale of ['ru', 'en', 'uk'] as const) {
      const translation = keeper.data.translations?.[locale];
      if (
        translation?.sourceRevision === keeper.data.sourceRevision &&
        typeof translation.name === 'string' &&
        translation.name.length > 0 &&
        translation.name.length <= 120
      )
        names[locale] = translation.name;
    }
    if (Object.keys(names).length) keeperDraft.labelTranslations = names;

    const compiled = compilePlayableDraft(draft);
    if (!compiled.playable)
      throw new Error(`INVALID_BUNDLED_ADVENTURE:${compiled.errors.join(';')}`);
    const data = {
      ...row.data,
      content: {
        ...row.data.content,
        rules:
          'Исследуйте обсерваторию, поговорите со смотрителем и найдите журнал на крыше. После развязки можно продолжить исследование.',
      },
    };
    compiled.playable.narrativePremise = {
      title: row.title,
      summary: row.synopsis,
      world: String(row.data.content?.world ?? ''),
      genre: row.genre,
    };
    const payload = {
      schemaVersion: 1,
      compiled: compiled.playable,
      source: {
        title: row.title,
        sourceLanguage: data.sourceLanguage,
        sourceRevision: data.sourceRevision,
        content: data.content,
      },
      npcDefinitions: definitions,
      editorialFixture: 'observatory-story-v1',
    };
    const versionId = randomUUID(),
      version = Number(row.version) + 1;
    const published = { ...row.published_snapshot, ...data, playableVersionId: versionId };
    const checksum = createHash('sha256')
      .update(JSON.stringify(canonical(payload)))
      .digest('hex');
    await c.query(
      'INSERT INTO adventure_game_drafts(adventure_id,revision,draft) VALUES($1,1,$2)',
      [row.id, JSON.stringify(draft)],
    );
    await c.query(
      "INSERT INTO game_playable_versions(id,adventure_id,source_revision,audience,package,checksum) VALUES($1,$2,1,'review',$3,$4)",
      [versionId, row.id, JSON.stringify(payload), checksum],
    );
    const editorial = (
      await c.query(
        'INSERT INTO adventure_versions(adventure_id,version,snapshot) VALUES($1,$2,$3) RETURNING id',
        [
          row.id,
          version,
          JSON.stringify({
            ...published,
            npcDefinitions: definitions.map((n) => ({ ...n.data, id: n.id })),
          }),
        ],
      )
    ).rows[0];
    await c.query(
      'INSERT INTO game_playable_approvals(playable_version_id,adventure_version_id) VALUES($1,$2)',
      [versionId, editorial.id],
    );
    await c.query(
      'UPDATE adventures SET data=$2,published_snapshot=$3,version=$4,updated_at=now() WHERE id=$1',
      [row.id, JSON.stringify(data), JSON.stringify(published), version],
    );
    await c.query(
      "INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,'seed.playable.firstparty',$2,$3)",
      [
        ownerId,
        row.id,
        JSON.stringify({ version, playableVersionId: versionId, fixture: 'observatory-story-v1' }),
      ],
    );
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
