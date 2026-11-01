import { StoryPlayableBuilder } from '@/components/visual-authoring/story-playable-builder';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StoryPlayableBuilder adventureId={id} />;
}
