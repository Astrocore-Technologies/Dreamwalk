'use client';
import { useEffect, useState } from 'react';
import { mapIntentSchema, type MapIntent } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { Field, Input, Select } from '../ui';
/** Geometry intent only: no grid overlay, movement setting or implicit regeneration. */
export function LocationMapIntent({
  value,
  onChange,
}: {
  value?: MapIntent;
  onChange: (value?: MapIntent) => void;
}) {
  const { locale } = useT();
  const i = locale === 'ru' ? 0 : locale === 'uk' ? 2 : 1;
  const copy = {
    title: ['Форма карты (необязательно)', 'Map shape (optional)', 'Форма карти (необов’язково)'],
    automatic: ['По описанию', 'From description', 'За описом'],
    dimensions: ['Точные размеры', 'Exact dimensions', 'Точні розміри'],
    aspect: ['Соотношение сторон', 'Aspect ratio', 'Співвідношення сторін'],
    width: ['Ширина', 'Width', 'Ширина'],
    height: ['Высота', 'Height', 'Висота'],
    help: [
      'Размеры — условные единицы плана, не пиксели экрана. Изменения применяются только при новой сборке карты, без сетки и изменения движения.',
      'Dimensions are plan units, not screen pixels. Changes apply only to a new map build; no grid or movement changes.',
      'Розміри — умовні одиниці плану, не пікселі екрана. Зміни застосовуються лише під час нової побудови карти, без сітки та зміни руху.',
    ],
    invalid: [
      'Нужны целые размеры 8–24 или соотношение, достижимое в этих пределах. Изменение не сохранено.',
      'Use integer dimensions 8–24, or an aspect achievable within those bounds. This change was not saved.',
      'Потрібні цілі розміри 8–24 або співвідношення, досяжне в цих межах. Зміну не збережено.',
    ],
  };
  const [width, setWidth] = useState(String(value?.width ?? 12)),
    [height, setHeight] = useState(String(value?.height ?? 8)),
    [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setWidth(String(value?.width ?? 12));
    setHeight(String(value?.height ?? 8));
    setInvalid(false);
  }, [value?.kind, value?.width, value?.height]);
  function save() {
    if (!value) return;
    const parsed = mapIntentSchema.safeParse({
      kind: value.kind,
      width: Number(width),
      height: Number(height),
    });
    setInvalid(!parsed.success);
    if (parsed.success) onChange(parsed.data);
  }
  return (
    <div className="stack">
      <Field label={copy.title[i]}>
        <Select
          value={value?.kind ?? 'automatic'}
          onChange={(e) => {
            setInvalid(false);
            onChange(
              e.target.value === 'automatic'
                ? undefined
                : e.target.value === 'aspect'
                  ? { kind: 'aspect', width: 2, height: 1 }
                  : { kind: 'dimensions', width: 12, height: 8 },
            );
          }}
        >
          <option value="automatic">{copy.automatic[i]}</option>
          <option value="dimensions">{copy.dimensions[i]}</option>
          <option value="aspect">{copy.aspect[i]}</option>
        </Select>
      </Field>
      {value && (
        <div className="row">
          <Field label={copy.width[i]}>
            <Input
              type="number"
              min={value.kind === 'dimensions' ? 8 : 1}
              max={24}
              step={1}
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              onBlur={save}
            />
          </Field>
          <Field label={copy.height[i]}>
            <Input
              type="number"
              min={value.kind === 'dimensions' ? 8 : 1}
              max={24}
              step={1}
              value={height}
              onChange={(e) => setHeight(e.target.value)}
              onBlur={save}
            />
          </Field>
        </div>
      )}
      <p className="muted">{copy.help[i]}</p>
      {invalid && <p role="alert">{copy.invalid[i]}</p>}
    </div>
  );
}
