/** Explain bounded planning failures without inferring that the author edited the source. */
export function mapPlanningMessage(code: string | null | undefined, locale: 'ru' | 'en' | 'uk') {
  const index = locale === 'en' ? 1 : locale === 'uk' ? 2 : 0;
  if (code === 'AUTHORING_STALE')
    return [
      'Подготовленный запрос больше нельзя использовать. Карта не применена; автоматического повтора нет.',
      'The prepared request is no longer valid. No map was applied; there is no automatic retry.',
      'Підготовлений запит більше не можна використати. Карту не застосовано; автоматичного повтору немає.',
    ][index];
  if (code === 'STORY_POSITION_REQUIRED')
    return [
      'В AI-плане не хватает обязательных позиций персонажей или переходов. Карта не применена; автоматического повтора нет.',
      'The AI plan is missing required character or passage positions. No map was applied; there is no automatic retry.',
      'В AI-плані бракує обов’язкових позицій персонажів або переходів. Карту не застосовано; автоматичного повтору немає.',
    ][index];
  if (code === 'STORY_SOURCE_MISMATCH')
    return [
      'AI-план не соответствует локациям или персонажам истории. Карта не применена; автоматического повтора нет.',
      'The AI plan does not match the story’s locations or characters. No map was applied; there is no automatic retry.',
      'AI-план не відповідає локаціям або персонажам історії. Карту не застосовано; автоматичного повтору немає.',
    ][index];
  if (
    [
      'STORY_CONNECTION_INVALID',
      'STORY_DISCONNECTED',
      'STORY_UNRESOLVED_PRESENCE_INVALID',
      'STORY_SCENE_PRESENCE_INVALID',
      'STORY_SCENE_ENTRY_INVALID',
      'STORY_SCENE_PRESENCE_EVIDENCE_REQUIRED',
      'STORY_MAP_INVALID',
      'AUTHORING_PROPOSAL_INVALID',
    ].includes(code ?? '')
  )
    return [
      'Созданный AI-план не прошёл проверку. Карта не применена; автоматического повтора нет.',
      'The generated AI plan did not pass validation. No map was applied; there is no automatic retry.',
      'Створений AI-план не пройшов перевірку. Карту не застосовано; автоматичного повтору немає.',
    ][index];
  if (code === 'AUTHORING_APPLY_FAILED')
    return [
      'Не удалось завершить проверку или сохранение AI-плана. Карта не применена; автоматического повтора нет.',
      'The AI plan could not be validated or saved. No map was applied; there is no automatic retry.',
      'Не вдалося завершити перевірку або збереження AI-плану. Карту не застосовано; автоматичного повтору немає.',
    ][index];
  if (code === 'AUTHORING_LATE_RESULT')
    return [
      'AI-план получен после завершения допустимого времени ожидания. Карта не применена; автоматического повтора нет.',
      'The AI plan arrived after the response deadline. No map was applied; there is no automatic retry.',
      'AI-план отримано після завершення допустимого часу очікування. Карту не застосовано; автоматичного повтору немає.',
    ][index];
  if (code !== 'MAP_GRID_REQUIRED' && !code?.startsWith('MAP_IMAGE_')) return null;
  if (code === 'MAP_GRID_REQUIRED')
    return [
      'Не удалось подтвердить клеточную карту с позициями персонажей. Подготовка не завершена; изображение сохранено, автоматического повтора нет.',
      'A grid with character positions could not be verified. Preparation is incomplete; the image is preserved and there is no automatic retry.',
      'Не вдалося підтвердити клітинну карту з позиціями персонажів. Підготовку не завершено; зображення збережено, автоматичного повтору немає.',
    ][index];
  if (code === 'MAP_IMAGE_UNCERTAIN')
    return [
      'Точные позиции на карте пока не удалось определить уверенно. Изображение сохранено; новый запрос не запускался.',
      'Exact positions on the map could not be established confidently. The image is saved; no new request was started.',
      'Точні позиції на карті поки не вдалося визначити впевнено. Зображення збережено; новий запит не запускався.',
    ][index];
  if (code === 'MAP_IMAGE_UNAVAILABLE')
    return [
      'Сохранённое изображение карты недоступно для этого плана. Новый запрос не запускался.',
      'The saved map image is unavailable for this plan. No new request was started.',
      'Збережене зображення карти недоступне для цього плану. Новий запит не запускався.',
    ][index];
  if (/SOURCE|INTEGRITY|CONTEXT|DUPLICATE/.test(code))
    return [
      'Не удалось подтвердить соответствие плана сохранённой карте. План не применён; автоматического повтора нет.',
      'The plan could not be matched to the saved map. It was not applied; there is no automatic retry.',
      'Не вдалося підтвердити відповідність плану збереженій карті. План не застосовано; автоматичного повтору немає.',
    ][index];
  return [
    'Размещение персонажей или переходов на карте не прошло проверку. План не применён; автоматического повтора нет.',
    'Character or passage placement on the map did not pass validation. The plan was not applied; there is no automatic retry.',
    'Розміщення персонажів або переходів на карті не пройшло перевірку. План не застосовано; автоматичного повтору немає.',
  ][index];
}
