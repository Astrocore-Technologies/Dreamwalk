import { settlementMessages } from '../game/known-npc-settlement-messages';
export const authoringSettlementMessages = {
  ru: {
    ...settlementMessages.ru,
    title: 'Завершить оплату запроса плана',
    hint: 'Запрос уже выполнен провайдером, но план не применён. Проверьте точную стоимость и отдельно подтвердите списание из сохранённого резерва.',
    noNew:
      'Новой генерации не будет. История, план и исходный запрос не изменятся. Подтверждение относится только к этому списанию.',
    providerCost: 'Фактическая стоимость у провайдера, USD',
    charged: 'Списано',
  },
  en: {
    ...settlementMessages.en,
    title: 'Settle the plan request cost',
    hint: 'The provider completed this request, but the plan was not applied. Review the exact cost and separately confirm the charge from its existing reservation.',
    noNew:
      'No new generation will run. The story, plan and original request remain unchanged. Your confirmation applies only to this charge.',
    providerCost: 'Actual provider cost, USD',
    charged: 'Charged',
  },
  uk: {
    ...settlementMessages.uk,
    title: 'Завершити оплату запиту плану',
    hint: 'Провайдер уже виконав запит, але план не застосовано. Перевірте точну вартість і окремо підтвердьте списання зі збереженого резерву.',
    noNew:
      'Нової генерації не буде. Історія, план і початковий запит не зміняться. Згода стосується лише цього списання.',
    providerCost: 'Фактична вартість у провайдера, USD',
    charged: 'Списано',
  },
} as const;
