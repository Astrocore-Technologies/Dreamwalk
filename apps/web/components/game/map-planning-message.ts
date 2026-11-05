/** Explain the verified failure category without guessing why the image was uncertain. */
export function mapPlanningMessage(code: string | null | undefined, locale: 'ru' | 'en' | 'uk') {
  if (!code?.startsWith('MAP_IMAGE_')) return null;
  const index = locale === 'en' ? 1 : locale === 'uk' ? 2 : 0;
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
