import { settlementMessages } from '../game/known-npc-settlement-messages';
export const authoringSettlementMessages = {
  ru: {
    ...settlementMessages.ru,
    title: 'Расчёт стоимости запроса',
    hint: 'План не применён. Подтверждённый расход рассчитывается автоматически в пределах исходного резерва.',
    noNew:
      'Новой генерации не будет. История, план и исходный запрос не изменятся. Ручное подтверждение не требуется.',
    providerCost: 'Фактическая стоимость у провайдера, USD',
    charged: 'Списано',
    automatic: 'Автоматически проверяем расход и остаток резерва.',
    uncertain: 'Расход пока не подтверждён. Резерв сохранён; повторного запроса не будет.',
  },
  en: {
    ...settlementMessages.en,
    title: 'Request cost status',
    hint: 'The plan was not applied. Verified usage is settled automatically within the original reservation.',
    noNew:
      'No new generation will run. The story, plan and original request remain unchanged. No manual confirmation is needed.',
    providerCost: 'Actual provider cost, USD',
    charged: 'Charged',
    automatic: 'Checking usage and the remaining reservation automatically.',
    uncertain:
      'Usage is not yet verified. The reservation is retained; the request will not be repeated.',
  },
  uk: {
    ...settlementMessages.uk,
    title: 'Розрахунок вартості запиту',
    hint: 'План не застосовано. Підтверджена витрата розраховується автоматично в межах початкового резерву.',
    noNew:
      'Нової генерації не буде. Історія, план і початковий запит не зміняться. Ручне підтвердження не потрібне.',
    providerCost: 'Фактична вартість у провайдера, USD',
    charged: 'Списано',
    automatic: 'Автоматично перевіряємо витрату й залишок резерву.',
    uncertain: 'Витрату ще не підтверджено. Резерв збережено; повторного запиту не буде.',
  },
} as const;
