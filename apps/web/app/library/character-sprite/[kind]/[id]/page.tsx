import { notFound } from 'next/navigation';
import { CharacterSpriteControl } from '@/components/visual-authoring/character-sprite-control';
export default async function Page({ params }: { params: Promise<{ kind: string; id: string }> }) {
  const { kind, id } = await params;
  if (kind !== 'npc' && kind !== 'hero') notFound();
  return <CharacterSpriteControl target={{ kind, id }} />;
}
