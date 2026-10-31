'use client';
import type { ObjectiveDefinition, ObjectiveCondition } from '@dreamwalk/contracts';
import { useObjectiveText } from '../game/campaign-objectives';
/** Only mounted in server-authorized immutable moderation review, never player view. */
export function ObjectiveReview({
  objectives,
  name,
}: {
  objectives?: ObjectiveDefinition[];
  name: (id: string) => string;
}) {
  const text = useObjectiveText();
  if (!objectives?.length) return null;
  const target = (condition: ObjectiveCondition) =>
    condition.kind === 'party_owns_item'
      ? condition.itemId
      : condition.kind === 'party_reaches_map'
        ? condition.mapId
        : condition.doorId;
  return (
    <section data-testid="objective-review">
      <h4>{text.title}</h4>
      {objectives.map((objective) => (
        <article key={objective.id}>
          <h5>{objective.title}</h5>
          <p>{objective.description}</p>
          <p>
            {text.epilogue}: {objective.epilogue}
          </p>
          <strong>{text[objective.completion.mode]}</strong>
          <ul>
            {objective.completion.conditions.map((condition, index) => (
              <li key={index}>
                {text[condition.kind]}: {name(target(condition))}
              </li>
            ))}
          </ul>
          {Object.entries(objective.translations || {}).map(([locale, copy]) => (
            <details key={locale}>
              <summary>{locale.toUpperCase()}</summary>
              <h5>{copy.title}</h5>
              <p>{copy.description}</p>
              <p>{copy.epilogue}</p>
            </details>
          ))}
        </article>
      ))}
    </section>
  );
}
