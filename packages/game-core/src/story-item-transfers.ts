import {
  footprintDistance,
  hasPosition,
  isActorConscious,
  type GameEntity,
  type GameState,
} from '@dreamwalk/contracts';
import { observedVisible } from './observation-visibility';

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim();
const words = (text: string) => normalize(text).match(/[\p{L}\p{N}_-]+/gu) ?? [];
const names = (item: GameEntity) =>
  [item.id, item.label ?? '', ...Object.values(item.labelTranslations ?? {})].filter(Boolean);
const mentions = (text: string, labels: string[]) => {
  const tokens = words(text).join(' ');
  return labels.some((label) => {
    const name = words(label).join(' ');
    return name.length > 1 && ` ${tokens} `.includes(` ${name} `);
  });
};
type ReferencedItem = { id: string; label?: string; labels: string[]; revision: number };

/** Private director capability, not an inventory dump or a command parser.
 * The model interprets the current attempt; the server limits it to objects the
 * player actually carries and names in that attempt, and visible existing actors. */
export function storyItemTransferContext(state: GameState, actorId: string, text: string) {
  const actor = state.entities[actorId];
  const items: ReferencedItem[] =
    actor?.kind === 'player' && isActorConscious(actor) && hasPosition(actor)
      ? [...new Set(actor.inventory ?? [])].flatMap((id) => {
          const item = state.entities[id];
          return item?.kind === 'item' && item.ownerId === actorId && mentions(text, names(item))
            ? [{ id, label: item.label, labels: names(item), revision: item.revision }]
            : [];
        })
      : [];
  const recipients = items.length
    ? Object.values(state.entities)
        .filter(
          (target) =>
            target.id !== actorId &&
            ['player', 'npc'].includes(target.kind) &&
            isActorConscious(target) &&
            !target.encounterId &&
            hasPosition(target) &&
            observedVisible(state, actor, target),
        )
        .map((target) => ({
          id: target.id,
          label: target.label,
          revision: target.revision,
          reachable: footprintDistance(actor, target) <= 1,
          hasCapacity:
            (target.inventory?.length ?? 0) < (state.worldItemRules?.inventoryCapacity ?? 128),
        }))
    : [];
  return { items, recipients };
}

/** A narrow receipt-pattern backstop, not a general prose classifier. Bind the
 * recipient, receipt verb and object locally: an actor giving a smile or returning
 * to a seat must never make an unrelated carried key require a physical transfer. */
export function claimedStoryItemTransfers(
  narration: string,
  items: ReferencedItem[],
  recipients: { id: string; label?: string }[],
): { itemId: string; recipientId: string }[] {
  const result = new Map<string, { itemId: string; recipientId: string }>();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receipt =
    'accepts?|accepted|receives?|received|принимает|принял|приняла|получает|получил|получила|приймає|прийняв|прийняла|отримує|отримав|отримала';
  const manner =
    'quietly|carefully|silently|gently|молча|бережно|осторожно|спокойно|обережно|мовчки';
  const determiner =
    'the|a|your|his|her|offered|extended|протянутый|поданный|предложенный|этот|тот|твой|ваш|твій|цей|запропонований';
  const actorNames = (recipient: { id: string; label?: string }) => {
    const base = [recipient.id, recipient.label ?? '']
      .map((name) => words(name).join(' '))
      .filter(Boolean);
    const name = normalize(recipient.label ?? '');
    // Bounded inflections of an already known single-word public name, never a
    // fuzzy identity lookup or new actor. In particular, Борису still means Борис.
    if (/^[а-яіїєґё]+$/u.test(name)) {
      if (/[бвгджзклмнпрстфхцчшщ]$/u.test(name))
        base.push(...['а', 'у', 'ом', 'е'].map((ending) => name + ending));
      if (name.endsWith('а'))
        base.push(...['ы', 'е', 'у', 'ой', 'і'].map((ending) => name.slice(0, -1) + ending));
    }
    return base;
  };
  let previousRecipient: string | undefined;
  let previousItem: string | undefined;
  for (const raw of normalize(narration).split(/[.!?;\n]+/u)) {
    if (/(?:^|[^\p{L}])(?:if|would|could|might|если|бы|якщо|би)(?=$|[^\p{L}])/u.test(raw)) {
      previousRecipient = undefined;
      previousItem = undefined;
      continue;
    }
    const clause = words(raw.replace(/"[^"]*"|«[^»]*»|“[^”]*”/gu, '')).join(' ');
    const namedRecipients = recipients.filter((recipient) =>
      mentions(clause, actorNames(recipient)),
    );
    const pronounRecipient =
      !namedRecipients.length && /^(?:he|she|он|она) /u.test(clause)
        ? previousRecipient
        : undefined;
    for (const item of items) {
      const aliases = item.labels.map((label) => words(label).join(' '));
      // A unique final noun covers ordinary abbreviated references ("the key")
      // without guessing among several carried objects with the same noun.
      for (const label of item.labels) {
        const noun = words(label).at(-1);
        if (
          noun &&
          noun.length >= 3 &&
          !items.some(
            (other) =>
              other.id !== item.id && other.labels.some((name) => words(name).at(-1) === noun),
          )
        )
          aliases.push(noun);
      }
      // A singleton in the player's attempt is not a prose antecedent: the
      // recipient may instead have just accepted a plan, advice or explanation.
      if (previousItem === item.id) aliases.push('it', 'его', 'её', 'ее', 'його', 'її');
      const object = [...new Set(aliases)]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length)
        .map(escape)
        .join('|');
      for (const recipient of recipients) {
        const actor = [
          ...actorNames(recipient),
          ...(pronounRecipient === recipient.id ? ['he', 'she', 'он', 'она'] : []),
        ]
          .map(escape)
          .join('|');
        const pattern = new RegExp(
          `(?:^| )(?:(?:${actor})) (?:(?:${manner}) ){0,2}(?:${receipt}) (?:(?:${determiner}) ){0,3}(?:${object})(?=$| )`,
          'u',
        );
        const match = pattern.exec(clause);
        const continuation = match ? clause.slice(match.index + match[0].length).trim() : '';
        const possessive = match && / (?:его|её|ее|його|її)$/u.test(match[0]);
        if (
          possessive &&
          continuation &&
          !/^(?:and|while|then|with|и|пока|затем|с|та|і|з|зі)(?: |$)/u.test(continuation)
        )
          continue;
        if (
          match &&
          !/^(?:as|как|як)(?: |$)/u.test(clause.slice(match.index + match[0].length).trim())
        )
          result.set(`${item.id}:${recipient.id}`, { itemId: item.id, recipientId: recipient.id });
      }
    }
    previousRecipient = namedRecipients.length === 1 ? namedRecipients[0].id : pronounRecipient;
    const trailingItems = items.filter((item) =>
      item.labels.some((label) => {
        const name = words(label).join(' ');
        return name.length > 1 && ` ${clause}`.endsWith(` ${name}`);
      }),
    );
    // Only the immediately preceding, explicitly named object can ground an
    // object pronoun. Do not carry it across unrelated or ambiguous sentences.
    previousItem = trailingItems.length === 1 ? trailingItems[0].id : undefined;
  }
  return [...result.values()];
}
