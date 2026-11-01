'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Layers, Plus, Search } from 'lucide-react';
import type { ControlledTag } from '@dreamwalk/contracts';
import {
  taxonomyUpdateSchema,
  type Taxonomy,
  type GenreDefinition,
} from '@dreamwalk/contracts/dist/taxonomy';
import { useT } from '@/lib/i18n';
import { api, errorMessage, useClient, useResource } from '@/lib/client';
import { Button, ErrorBox, Field, Input, Loading, Modal, Panel } from '../ui';
import styles from './admin.module.css';

const copy = {
  ru: {
    chooseTag: 'Выбрать тег',
    chooseGenre: 'Выбрать жанр',
    addGenre: 'Добавить жанр',
    search: 'Поиск',
    genre: 'ID жанра',
    none: 'Ничего не найдено',
    discard: 'Убрать новую запись',
    select: 'Выбери запись или добавь новую.',
    invalid:
      'Заполни название каждого жанра, ID и все переводы каждого тега. Пустые или повторяющиеся записи нельзя сохранить.',
  },
  en: {
    chooseTag: 'Choose tag',
    chooseGenre: 'Choose genre',
    addGenre: 'Add genre',
    search: 'Search',
    genre: 'Genre ID',
    none: 'No results',
    discard: 'Discard new entry',
    select: 'Choose an entry or add a new one.',
    invalid:
      'Complete every genre name, tag ID and tag translation. Empty or duplicate entries cannot be saved.',
  },
  uk: {
    chooseTag: 'Вибрати тег',
    chooseGenre: 'Вибрати жанр',
    addGenre: 'Додати жанр',
    search: 'Пошук',
    genre: 'ID жанру',
    none: 'Нічого не знайдено',
    discard: 'Прибрати новий запис',
    select: 'Вибери запис або додай новий.',
    invalid:
      'Заповни назву кожного жанру, ID і всі переклади кожного тегу. Порожні або повторювані записи не можна зберегти.',
  },
};
export function AdminTaxonomy() {
  const { t, locale } = useT(),
    { toast } = useClient();
  const text = copy[locale];
  const resource = useResource<Taxonomy>('/admin/taxonomy');
  const [genres, setGenres] = useState<GenreDefinition[]>([]),
    [tags, setTags] = useState<ControlledTag[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<number | null>(null),
    [selectedTag, setSelectedTag] = useState<number | null>(null);
  const [picker, setPicker] = useState<'genres' | 'tags' | null>(null),
    [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (resource.data) {
      setGenres(
        resource.data.genres.map((value) =>
          resource.data!.genreDefinitions.find((genre) => genre.value === value)!,
        ),
      );
      setTags(resource.data.tags);
    }
  }, [resource.data]);
  const tag = selectedTag === null ? undefined : tags[selectedTag];
  function openPicker(kind: 'genres' | 'tags') {
    setQuery('');
    setPicker(kind);
  }
  function updateTag(next: ControlledTag) {
    setTags(tags.map((value, index) => (index === selectedTag ? next : value)));
  }
  const pickerEntries = (
    picker === 'tags'
      ? tags.map((value, index) => ({
          index,
          label: value.labels[locale] || value.id || t('Добавить тег'),
          search: [value.id, ...Object.values(value.labels), ...value.aliases].join(' '),
        }))
      : genres.map((value, index) => ({
          index,
          label: value.labels[locale] || value.id || text.addGenre,
          search: [value.id, value.value, ...Object.values(value.labels)].join(' '),
        }))
  ).filter((value) => value.search.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const historical = (resource.data?.genreDefinitions ?? []).filter(
      (entry) => !genres.some((genre) => genre.value === entry.value),
    );
    const body = {
      genres: genres.map((entry) => entry.value),
      tags,
      genreDefinitions: [...historical, ...genres],
      expectedRevision: resource.data?.revision,
    };
    if (
      !taxonomyUpdateSchema.safeParse(body).success ||
      new Set(genres.map((entry) => entry.id)).size !== genres.length ||
      new Set(tags.map((entry) => entry.id)).size !== tags.length
    ) {
      setError(text.invalid);
      return;
    }
    setBusy(true);
    setError('');
    try {
      resource.setData(
        await api<Taxonomy>('/admin/taxonomy', {
          method: 'PATCH',
          body: JSON.stringify(body),
        }),
      );
      window.dispatchEvent(new Event('dreamwalk:taxonomy-updated'));
      toast(t('Жанры и теги сохранены'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.sectionHeading}>
        <Layers size={22} />
        <h2>{t('Жанры и теги')}</h2>
      </div>
      <div className="notice">
        {t(
          'Справочник помогает ориентироваться в каталоге. Изменения не переписывают жанры и теги уже созданных историй.',
        )}
      </div>
      <ErrorBox message={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : (
        <Panel>
          <form method="post" className="stack" onSubmit={(e) => void save(e)}>
            <fieldset disabled={busy} className="stack">
              <legend>{t('Жанры')}</legend>
              <div className="form-actions">
                <Button type="button" variant="secondary" onClick={() => openPicker('genres')}>
                  <Search size={16} />
                  {text.chooseGenre}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={genres.length >= 50}
                  onClick={() => {
                    setSelectedGenre(genres.length);
                    setGenres([
                      ...genres,
                      { id: '', value: '', labels: { uk: '', en: '', ru: '' } },
                    ]);
                  }}
                >
                  <Plus size={16} />
                  {text.addGenre}
                </Button>
              </div>
              {selectedGenre !== null && genres[selectedGenre] !== undefined ? (
                <div className="stack">
                  <Field label={text.genre}>
                    <Input
                      required
                      pattern="[a-z][a-z0-9-]{1,39}"
                      maxLength={40}
                      readOnly={selectedGenre < (resource.data?.genres.length ?? 0)}
                      value={genres[selectedGenre].id}
                      onChange={(e) =>
                        setGenres(
                          genres.map((value, index) =>
                            index === selectedGenre
                              ? { ...value, id: e.target.value, value: e.target.value }
                              : value,
                          ),
                        )
                      }
                    />
                  </Field>
                  {(['uk', 'en', 'ru'] as const).map((language) => (
                    <Field
                      key={language}
                      label={t(
                        language === 'uk'
                          ? 'Украинский'
                          : language === 'en'
                            ? 'Английский'
                            : 'Русский',
                      )}
                    >
                      <Input
                        required
                        maxLength={40}
                        value={genres[selectedGenre].labels[language]}
                        onChange={(e) =>
                          setGenres(
                            genres.map((value, index) =>
                              index === selectedGenre
                                ? {
                                    ...value,
                                    labels: { ...value.labels, [language]: e.target.value },
                                  }
                                : value,
                            ),
                          )
                        }
                      />
                    </Field>
                  ))}
                  {selectedGenre >= (resource.data?.genres.length ?? 0) && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setGenres(genres.filter((_, index) => index !== selectedGenre));
                        setSelectedGenre(null);
                      }}
                    >
                      {text.discard}
                    </Button>
                  )}
                </div>
              ) : (
                <p className="muted">{text.select}</p>
              )}
            </fieldset>
            <fieldset disabled={busy} className="stack">
              <legend>{t('Рекомендуемые теги')}</legend>
              <div className="form-actions">
                <Button type="button" variant="secondary" onClick={() => openPicker('tags')}>
                  <Search size={16} />
                  {text.chooseTag}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={tags.length >= 100}
                  onClick={() => {
                    setSelectedTag(tags.length);
                    setTags([...tags, { id: '', labels: { uk: '', en: '', ru: '' }, aliases: [] }]);
                  }}
                >
                  <Plus size={16} />
                  {t('Добавить тег')}
                </Button>
              </div>
              {tag ? (
                <div className="stack">
                  <Field label={t('ID тега')}>
                    <Input
                      required
                      pattern="[a-z][a-z0-9-]{1,39}"
                      maxLength={40}
                      readOnly={
                        selectedTag !== null && selectedTag < (resource.data?.tags.length ?? 0)
                      }
                      value={tag.id}
                      onChange={(e) => updateTag({ ...tag, id: e.target.value })}
                    />
                  </Field>
                  {(['uk', 'en', 'ru'] as const).map((language) => (
                    <Field
                      key={language}
                      label={t(
                        language === 'uk'
                          ? 'Украинский'
                          : language === 'en'
                            ? 'Английский'
                            : 'Русский',
                      )}
                    >
                      <Input
                        required
                        maxLength={40}
                        value={tag.labels[language]}
                        onChange={(e) =>
                          updateTag({
                            ...tag,
                            labels: { ...tag.labels, [language]: e.target.value },
                          })
                        }
                      />
                    </Field>
                  ))}
                  {selectedTag !== null && selectedTag >= (resource.data?.tags.length ?? 0) && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        setTags(tags.filter((_, index) => index !== selectedTag));
                        setSelectedTag(null);
                      }}
                    >
                      {text.discard}
                    </Button>
                  )}
                </div>
              ) : (
                <p className="muted">{text.select}</p>
              )}
            </fieldset>
            <ErrorBox message={error} />
            <div className="form-actions">
              <Button
                variant="secondary"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (resource.data) {
                    setGenres(
                      resource.data.genres.map((value) =>
                        resource.data!.genreDefinitions.find((genre) => genre.value === value)!,
                      ),
                    );
                    setTags(resource.data.tags);
                  }
                  setSelectedGenre(null);
                  setSelectedTag(null);
                  setError('');
                }}
              >
                {t('Отменить изменения')}
              </Button>
              <Button type="submit" busy={busy}>
                {t('Сохранить справочник')}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      {picker && (
        <Modal
          title={picker === 'tags' ? text.chooseTag : text.chooseGenre}
          onClose={() => setPicker(null)}
        >
          <div className="stack">
            <Field label={text.search}>
              <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} />
            </Field>
            <div className={styles.taxonomyPicker}>
              {pickerEntries.length === 0 && <p role="status">{text.none}</p>}
              {pickerEntries.map((value) => (
                <Button
                  key={value.index}
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    if (picker === 'tags') setSelectedTag(value.index);
                    else setSelectedGenre(value.index);
                    setPicker(null);
                  }}
                >
                  {value.label}
                </Button>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
