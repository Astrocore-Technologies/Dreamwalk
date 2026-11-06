export const settlementMessages = {
  ru: {
    legacyHint:
      'Старый запрос был принят до автоматического расчёта. Можно закрыть только его подтверждённый расход и освободить остаток резерва.',
    legacy: 'Проверь точные суммы перед подтверждением старой операции.',
    backWallet: 'К резервам кошелька',
    title: 'Статус расчёта',
    hint: 'Запрос к ИИ уже выполнен, но его результат не применён в игре. Система автоматически учтёт подтверждённую стоимость и освободит остаток резерва.',
    noNew: 'Новых запросов к ИИ и изменений в игре не будет.',
    automatic: 'Статус расчёта обновляется автоматически. Подтверждённая сумма появится здесь.',
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
      'Подтверждённый расчёт пока недоступен. Статус обновляется автоматически; новый запрос к ИИ не создаётся.',
  },
  en: {
    legacyHint:
      'This older request predates automatic settlement. Only its verified cost can be charged and the remaining reservation released.',
    legacy: 'Review the exact amounts before confirming this older operation.',
    backWallet: 'Wallet reservations',
    title: 'Charge status',
    hint: 'The AI request already ran, but its result was not applied to the game. The system automatically settles the verified cost and releases the remaining reservation.',
    noNew: 'This makes no new AI requests or game changes.',
    automatic: 'Settlement status refreshes automatically. The confirmed amount will appear here.',
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
      'A verified settlement is not available yet. Status refreshes automatically without creating another AI request.',
  },
  uk: {
    legacyHint:
      'Цей старий запит прийнято до автоматичного розрахунку. Можна закрити лише його підтверджену вартість і звільнити решту резерву.',
    legacy: 'Перевір точні суми перед підтвердженням старої операції.',
    backWallet: 'До резервів гаманця',
    title: 'Статус розрахунку',
    hint: 'Запит до ШІ вже виконано, але його результат не застосовано у грі. Система автоматично врахує підтверджену вартість і звільнить решту резерву.',
    noNew: 'Нових запитів до ШІ та змін у грі не буде.',
    automatic: 'Статус розрахунку оновлюється автоматично. Підтверджена сума з’явиться тут.',
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
      'Підтверджений розрахунок поки недоступний. Статус оновлюється автоматично без нового запиту до ШІ.',
  },
} as const;
