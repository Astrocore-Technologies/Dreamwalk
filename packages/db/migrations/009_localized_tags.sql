-- Preserve existing custom taxonomy values; recognize historical strings through aliases.
WITH curated(id,ru,en,uk) AS (VALUES
 ('puzzles','Загадки','Puzzles','Загадки'),
 ('mysteries','Тайны','Mysteries','Таємниці'),
 ('atmosphere','Атмосфера','Atmosphere','Атмосфера'),
 ('exploration','Исследование','Exploration','Дослідження'),
 ('magic','Магия','Magic','Магія'),
 ('sea','Море','Sea','Море'),
 ('choices','Выбор','Choices','Вибір'),
 ('relationships','Отношения','Relationships','Стосунки'),
 ('cozy','Уют','Cozy','Затишок')
), converted AS (
 SELECT jsonb_agg(CASE WHEN jsonb_typeof(tag)='object' THEN tag ELSE
 jsonb_build_object('id',COALESCE(c.id,'legacy-'||substr(md5(tag#>>'{}'),1,20)),
 'labels',jsonb_build_object('ru',COALESCE(c.ru,tag#>>'{}'),'en',COALESCE(c.en,tag#>>'{}'),'uk',COALESCE(c.uk,tag#>>'{}')),
 'aliases',jsonb_build_array(tag#>>'{}')) END ORDER BY ordinal) AS tags
 FROM platform_settings p CROSS JOIN LATERAL jsonb_array_elements(p.value->'tags') WITH ORDINALITY AS t(tag,ordinal)
 LEFT JOIN curated c ON c.ru=tag#>>'{}' WHERE p.key='taxonomy'
)
UPDATE platform_settings SET value=jsonb_set(value,'{tags}',COALESCE(converted.tags,'[]'::jsonb)),updated_at=now() FROM converted WHERE key='taxonomy';
