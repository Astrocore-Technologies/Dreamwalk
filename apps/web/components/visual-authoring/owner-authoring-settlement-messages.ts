import { settlementMessages } from '../game/known-npc-settlement-messages';
export const authoringSettlementMessages = {
  ru: {
    ...settlementMessages.ru,
    title: 'Расчёт стоимости запроса',
    hint: 'План не применён. Здесь показан статус расчёта по исходному запросу.',
    legacyHint:
      'В исходном согласии на этот старый запрос не было разрешения на списание при неудаче. Подтверди отдельно только указанные ниже суммы.',
    noNew: 'Новой генерации не будет. История, план и исходный запрос не изменятся.',
    providerCost: 'Фактическая стоимость у провайдера, USD',
    charged: 'Списано',
    automatic:
      'Автоматически проверяем расход и остаток резерва. Ручное подтверждение не требуется.',
    legacy:
      'Суммы подтверждены. Для списания стоимости старого запроса и возврата остатка нужно отдельное согласие.',
    uncertain:
      'Ответ на подтверждение не получен. Проверяем статус; повторное подтверждение использует тот же номер операции и не запускает генерацию.',
  },
  en: {
    ...settlementMessages.en,
    title: 'Request cost status',
    hint: 'The plan was not applied. This shows settlement status for the original request.',
    legacyHint:
      'The original consent for this older request did not cover charging for a failed result. Separately confirm only the exact amounts below.',
    noNew: 'No new generation will run. The story, plan and original request remain unchanged.',
    providerCost: 'Actual provider cost, USD',
    charged: 'Charged',
    automatic:
      'Checking usage and the remaining reservation automatically. No manual confirmation is needed.',
    legacy:
      'The amounts are verified. Charging this older request and returning the remainder requires separate consent.',
    uncertain:
      'The confirmation response was not received. Checking status; retrying confirmation uses the same operation reference and runs no generation.',
  },
  uk: {
    ...settlementMessages.uk,
    title: 'Розрахунок вартості запиту',
    hint: 'План не застосовано. Тут показано статус розрахунку за початковим запитом.',
    legacyHint:
      'Початкова згода на цей старий запит не дозволяла списання за невдалий результат. Окремо підтвердь лише точні суми нижче.',
    noNew: 'Нової генерації не буде. Історія, план і початковий запит не зміняться.',
    providerCost: 'Фактична вартість у провайдера, USD',
    charged: 'Списано',
    automatic:
      'Автоматично перевіряємо витрату й залишок резерву. Ручне підтвердження не потрібне.',
    legacy:
      'Суми підтверджено. Для списання вартості старого запиту й повернення решти потрібна окрема згода.',
    uncertain:
      'Відповідь на підтвердження не отримано. Перевіряємо статус; повторне підтвердження використовує той самий номер операції й не запускає генерацію.',
  },
} as const;
