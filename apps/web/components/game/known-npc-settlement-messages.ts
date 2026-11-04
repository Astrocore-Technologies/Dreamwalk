export const settlementMessages = {
  ru: {
    title: 'Завершить списание',
    hint: 'Запрос к ИИ уже выполнен, но его результат не применён в игре. Здесь можно оплатить его точную стоимость и освободить остаток резерва.',
    noNew:
      'Новых запросов к ИИ и изменений в игре не будет. Это согласие касается только этого списания.',
    reserve: 'Резерв, эквивалент искр',
    charge: 'К списанию',
    release: 'Вернётся в баланс',
    dreams: 'Грёзы',
    sparks: 'Искры',
    confirm: 'Подтвердить списание',
    retry: 'Повторить подтверждение',
    refresh: 'Проверить статус',
    back: 'Вернуться в игру',
    loading: 'Проверяем сохранённую стоимость…',
    sending: 'Проверяем сумму и завершаем списание…',
    complete: 'Списание завершено. Остаток резерва освобождён.',
    released: 'Резерв уже освобождён. Подтверждать списание не нужно.',
    unavailable:
      'Не удалось получить доступную сверку. Проверь аккаунт владельца и обнови статус. Новое списание не отправлено.',
    changed:
      'Сумма или резерв изменились. Подтверждение остановлено. Обнови статус; прежнюю попытку нельзя заменить новой.',
    storage:
      'Не удалось безопасно сохранить или прочитать номер подтверждения. Новое списание не отправлено. Проверь статус перед продолжением.',
    uncertain:
      'Ответ на подтверждение не получен. Сначала проверь статус. Повторное подтверждение использует тот же номер операции и не создаёт второе списание.',
  },
  en: {
    title: 'Complete the charge',
    hint: 'The AI request already ran, but its result was not applied to the game. Settle its exact cost and release the rest of the reservation here.',
    noNew:
      'This makes no new AI requests or game changes. Your confirmation applies only to this charge.',
    reserve: 'Reservation, in Spark equivalents',
    charge: 'To charge',
    release: 'Returned to balance',
    dreams: 'Dreams',
    sparks: 'Sparks',
    confirm: 'Confirm charge',
    retry: 'Retry confirmation',
    refresh: 'Check status',
    back: 'Return to game',
    loading: 'Checking the recorded cost…',
    sending: 'Checking the amount and completing the charge…',
    complete: 'Charge completed. The remaining reservation has been released.',
    released: 'The reservation is already released. No charge confirmation is needed.',
    unavailable:
      'No eligible settlement could be loaded. Check the owner account and refresh the status. No new charge was sent.',
    changed:
      'The amount or reservation changed. Confirmation stopped. Check the status; the earlier attempt cannot be replaced.',
    storage:
      'The confirmation reference could not be safely saved or read. No new charge was sent. Check the status before continuing.',
    uncertain:
      'The confirmation response was not received. Check the status first. Retrying uses the same operation reference and cannot create a second charge.',
  },
  uk: {
    title: 'Завершити списання',
    hint: 'Запит до ШІ вже виконано, але його результат не застосовано у грі. Тут можна сплатити точну вартість і звільнити решту резерву.',
    noNew: 'Нових запитів до ШІ та змін у грі не буде. Згода стосується лише цього списання.',
    reserve: 'Резерв, еквівалент іскор',
    charge: 'До списання',
    release: 'Повернеться на баланс',
    dreams: 'Мрії',
    sparks: 'Іскри',
    confirm: 'Підтвердити списання',
    retry: 'Повторити підтвердження',
    refresh: 'Перевірити статус',
    back: 'Повернутися до гри',
    loading: 'Перевіряємо збережену вартість…',
    sending: 'Перевіряємо суму та завершуємо списання…',
    complete: 'Списання завершено. Залишок резерву звільнено.',
    released: 'Резерв уже звільнено. Підтверджувати списання не потрібно.',
    unavailable:
      'Не вдалося завантажити доступне врегулювання. Перевір обліковий запис власника й онови статус. Нове списання не надіслано.',
    changed:
      'Сума або резерв змінилися. Підтвердження зупинено. Онови статус; попередню спробу не можна замінити новою.',
    storage:
      'Не вдалося безпечно зберегти або прочитати номер підтвердження. Нове списання не надіслано. Перевір статус перед продовженням.',
    uncertain:
      'Відповідь на підтвердження не отримано. Спочатку перевір статус. Повторне підтвердження використовує той самий номер операції й не створює другого списання.',
  },
} as const;
