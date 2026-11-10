// Public texts of the About, Rules and Privacy pages. Plain text with **bold** only; the pages
// render it as escaped text. The operator facts below are the single place to change them.
// Not legal advice: have a lawyer review before the public launch.
const operator = 'Astrocore Technologies';
const email = 'dreamwalkrp@gmail.com';

export const legalCopy = {
  ru: {
    '/about': {
      title: 'О Dreamwalk',
      paragraphs: [
        '**Dreamwalk развивается.** Часть возможностей может быть доступна не всем и меняться со временем.',
        'Dreamwalk — платформа, где игрок и ИИ вместе рассказывают визуальную историю. Автор задаёт начало мира и его правила, а дальше история продолжается в игре: появляются новые события, герои и места, а иллюстрации опираются на то, что уже произошло.',
        'Выбирай приключения в каталоге, создавай своего героя и играй один или с друзьями. Персонажи помнят разговоры, а игровой движок хранит состояние истории и следит, чтобы мир оставался последовательным. ИИ может ошибаться, поэтому последнее слово о том, что произошло, всегда за движком, а не за ИИ.',
        'В студии автор создаёт историю, локации, персонажей и рисованные иллюстрации. Историю можно оставить приватной, поделиться ею по приглашению или предложить в публичный каталог — после проверки. Права на изображения остаются за их автором: использовать чужие изображения без его разрешения нельзя.',
        `**Кто за этим стоит.** Dreamwalk разрабатывает ${operator} (Украина). Вопросы, жалобы и обращения: ${email}.`,
      ],
    },
    '/terms': {
      title: 'Правила Dreamwalk',
      paragraphs: [
        `**Коротко.** Это правила пользования Dreamwalk (www.dreamwalk.online). Пользуясь сервисом, ты принимаешь их; если не согласен — не пользуйся. Мы можем обновлять правила: действует редакция на этой странице.`,
        `**Кто мы.** Сервис предоставляет ${operator}, Украина. Связаться с нами можно по адресу ${email}.`,
        '**Возраст.** Dreamwalk предназначен для людей от 14 лет. Автор указывает возрастную категорию публичной истории — 14+, 16+ или 18+ — и отвечает за то, чтобы содержание ей соответствовало. Не открывай истории, категория которых выше твоего возраста. Мы можем изменить категорию или скрыть историю, если она ей не соответствует.',
        '**Аккаунт и безопасность.** Храни доступ к аккаунту в тайне и не пользуйся чужим. Не пытайся получить доступ к чужим приватным материалам. Не загружай вредоносные файлы, не рассылай спам, не обходи лимиты и не собирай данные сервиса автоматически.',
        '**Что запрещено.** Любая эксплуатация и сексуализация детей, в том числе вымышленных персонажей, которые изображены или описаны как дети. Инструкции, помогающие причинить реальный вред людям. Травля и преследование. Разжигание ненависти по признаку расы, национальности, религии, пола, ориентации или инвалидности. Тёмные темы в художественной истории допустимы, пока она не превращается в инструкцию, пропаганду ненависти или травлю; о чувствительных темах предупреждай в описании истории.',
        '**Спам, обман и плагиат.** Не публикуй спам и мошеннические материалы, не выдавай чужую историю за свою и не вводи людей в заблуждение. Внешние ссылки допустимы, только если они безопасны: без вредоносных и фишинговых страниц.',
        '**Самоповреждение и жестокость.** Не публикуй материалы, которые поощряют самоубийство, самоповреждение или расстройства пищевого поведения. Насилие в вымысле допустимо, но без смакования реального насилия и без инструкций. Если тебе тяжело, обратись к близким или в службу поддержки.',
        '**Откровенный контент.** Сексуальный контент допускается только в текстовых ответах ИИ, только в историях категории 18+ и только с вымышленными взрослыми персонажами. Откровенные сексуальные изображения запрещены.',
        '**Материалы и права.** Свои материалы ты сохраняешь за собой. Загружай и публикуй только то, на что у тебя есть права: тексты, персонажей, изображения, портреты-референсы. Соблюдай лицензии и указание авторства. Фанатские истории по чужим мирам допустимы, если не нарушают права, но пометка «фанатское» сама по себе разрешением не является. Публикуя материал, ты даёшь Dreamwalk неисключительное право хранить, показывать и обрабатывать его (в том числе отправлять ИИ-провайдеру) в той мере, в какой это нужно для работы сервиса.',
        '**Изображения в историях.** Если изображение показано в публичной истории, это не значит, что его можно копировать или переделывать. Пользуйся разрешениями библиотеки ассетов. Отзыв разрешения действует на новые использования; уже скачанные копии при этом не исчезают.',
        '**ИИ.** ИИ может ошибаться и выдавать вымышленное как факты. Ответы персонажей — часть игры, а не совет по здоровью, праву или финансам. Проверяй сгенерированное перед публикацией: мы не гарантируем его уникальность и отсутствие чужих прав. Какие данные получают ИИ-провайдеры, написано в политике конфиденциальности.',
        `**Жалобы и модерация.** О нарушении можно сообщить кнопкой «Сообщить о нарушении» или письмом на ${email} со ссылкой на материал и описанием проблемы. Правообладатель указывает, что именно и на каком основании нарушено. Мы можем скрыть или удалить материал и ограничить аккаунт. Решение можно оспорить письмом на тот же адрес.`,
        '**Последствия нарушений.** Мы можем предупредить автора, скрыть материал, ограничить функции или закрыть аккаунт. За тяжёлые нарушения, например эксплуатацию детей или угрозы, доступ закрывается сразу, а при необходимости мы передаём сведения правоохранительным органам.',
        '**Искры и платежи.** Платных функций и приёма платежей сейчас нет. Искры — внутренние единицы для ИИ-генерации; демо-баланс не является деньгами, не покупается, не обменивается на деньги и не возвращается. Если платные функции появятся, условия мы опубликуем заранее.',
        '**Ответственность и изменения.** Сервис предоставляется «как есть», без гарантии бесперебойной работы. В пределах, допустимых законом, мы не отвечаем за косвенные убытки. За нарушение правил мы можем ограничить или закрыть доступ. К этим правилам применяется законодательство Украины.',
      ],
    },
    '/privacy': {
      title: 'Политика конфиденциальности',
      paragraphs: [
        `**Коротко.** Мы собираем только то, что нужно для работы Dreamwalk, не продаём данные и не показываем рекламу. Ответственный за данные — ${operator} (Украина), обращения: ${email}.`,
        '**Какие данные мы получаем.** Данные аккаунта: email, имя, хеш пароля, профиль и настройки. При входе через Google — email, имя и идентификатор Google; пароль Google мы не получаем. Твои материалы: истории, герои, NPC и изображения. Игровые данные: действия, сообщения, состояние игры и память персонажей. Технические данные: сессии, IP-адрес и время запросов для безопасности и защиты от злоупотреблений, учёт Искр.',
        '**Зачем мы это используем.** Чтобы работали аккаунт, игра и студия, отправлялись письма (подтверждение, уведомления), работала защита от злоупотреблений и модерация, а также чтобы разбирать обращения. Для этого достаточно данных выше, больше мы не собираем.',
        '**Кому данные передаются.** Сайт размещён на Vercel, API и база данных — на Railway; письма отправляет Brevo; вход через Google обеспечивает Google. Серверы этих сервисов могут находиться за пределами Украины. Для генерации текста мы используем OpenRouter, который передаёт запрос выбранной модели стороннего провайдера; список моделей меняется. Если включена генерация изображений, запрос уходит выбранному провайдеру изображений. Остальным третьим лицам данные мы не продаём.',
        '**Что получает ИИ.** При генерации провайдеру уходят нужные фрагменты текста истории, контекст разговора и выбранные изображения. Приватная история не означает, что передачи нет. Правила хранения и обучения у провайдеров разные: мы стараемся выбирать модели, которые не используют запросы для обучения, но гарантировать этого не можем. Не вводи в игру и в истории документы, пароли и чувствительные данные о себе и других людях.',
        '**Cookies и аналитика.** Сейчас мы используем только необходимое: cookie сессии и сохранённые в браузере тему и язык. Если подключим аналитику посещаемости, сообщим об этом здесь и, где требуется, спросим согласие.',
        '**Безопасность данных.** Пароли хранятся только в виде хеша, соединение с сайтом шифруется (HTTPS), доступ к данным ограничен ролями. Ни один сервис не защищён полностью; о значимой утечке, затрагивающей твои данные, мы сообщим.',
        '**Сколько мы храним данные.** Пока существует аккаунт. После удаления аккаунта сессии завершаются, а профиль обезличивается сразу; остальные личные данные мы удаляем из рабочей базы в течение 30 дней. Резервные копии перезаписываются по мере ротации. Записи учёта и итоги общей игры с другими людьми могут остаться в обезличенном виде. Технические журналы хранятся ограниченное время, не дольше, чем нужно для безопасности.',
        `**Твои права.** В настройках можно запросить экспорт данных (готовый экспорт доступен для скачивания семь дней), завершить все сессии и удалить аккаунт. По адресу ${email} можно попросить исправить данные, отозвать согласие или удалить их; ответим в течение 30 дней. Если ты находишься в ЕС или ЕЭЗ, тебе также доступны права по GDPR, в том числе жалоба в надзорный орган.`,
        '**Возраст и изменения.** Dreamwalk предназначен для людей от 14 лет; если мы узнаем об аккаунте младшего пользователя, мы его закроем. При существенных изменениях мы обновим эту страницу и дату редакции.',
      ],
    },
  },
  uk: {
    '/about': {
      title: 'Про Dreamwalk',
      paragraphs: [
        '**Dreamwalk розвивається.** Частина можливостей може бути доступна не всім і змінюватися з часом.',
        'Dreamwalk — платформа, де гравець і ШІ разом розповідають візуальну історію. Автор задає початок світу та його правила, а далі історія триває в грі: з’являються нові події, герої й місця, а ілюстрації спираються на те, що вже сталося.',
        'Обирай пригоди в каталозі, створюй свого героя й грай сам або з друзями. Персонажі пам’ятають розмови, а ігровий рушій зберігає стан історії та стежить, щоб світ залишався послідовним. ШІ може помилятися, тому останнє слово про те, що сталося, завжди за рушієм, а не за ШІ.',
        'У студії автор створює історію, локації, персонажів і намальовані ілюстрації. Історію можна залишити приватною, поділитися нею за запрошенням або запропонувати до публічного каталогу — після перевірки. Права на зображення залишаються за їхнім автором: використовувати чужі зображення без його дозволу не можна.',
        `**Хто за цим стоїть.** Dreamwalk розробляє ${operator} (Україна). Питання, скарги та звернення: ${email}.`,
      ],
    },
    '/terms': {
      title: 'Правила Dreamwalk',
      paragraphs: [
        '**Коротко.** Це правила користування Dreamwalk (www.dreamwalk.online). Користуючись сервісом, ти приймаєш їх; якщо не згоден — не користуйся. Ми можемо оновлювати правила: діє редакція на цій сторінці.',
        `**Хто ми.** Сервіс надає ${operator}, Україна. Зв’язатися з нами можна за адресою ${email}.`,
        '**Вік.** Dreamwalk призначений для людей від 14 років. Автор указує вікову категорію публічної історії — 14+, 16+ або 18+ — і відповідає за те, щоб зміст їй відповідав. Не відкривай історії, категорія яких вища за твій вік. Ми можемо змінити категорію або приховати історію, якщо вона їй не відповідає.',
        '**Акаунт і безпека.** Зберігай доступ до акаунта в таємниці й не користуйся чужим. Не намагайся отримати доступ до чужих приватних матеріалів. Не завантажуй шкідливі файли, не розсилай спам, не обходь ліміти й не збирай дані сервісу автоматично.',
        '**Що заборонено.** Будь-яка експлуатація та сексуалізація дітей, зокрема вигаданих персонажів, зображених або описаних як діти. Інструкції, що допомагають завдати реальної шкоди людям. Цькування та переслідування. Розпалювання ненависті за ознакою раси, національності, релігії, статі, орієнтації чи інвалідності. Темні теми в художній історії припустимі, доки вона не перетворюється на інструкцію, пропаганду ненависті чи цькування; про чутливі теми попереджай в описі історії.',
        '**Спам, обман і плагіат.** Не публікуй спам і шахрайські матеріали, не видавай чужу історію за свою й не вводь людей в оману. Зовнішні посилання припустимі, лише якщо вони безпечні: без шкідливих і фішингових сторінок.',
        '**Самоушкодження та жорстокість.** Не публікуй матеріали, що заохочують самогубство, самоушкодження чи розлади харчової поведінки. Насильство у вигадці припустиме, але без смакування реального насильства й без інструкцій. Якщо тобі важко, звернися до близьких або до служби підтримки.',
        '**Відвертий контент.** Сексуальний контент допускається лише в текстових відповідях ШІ, лише в історіях категорії 18+ і лише з вигаданими дорослими персонажами. Відверті сексуальні зображення заборонені.',
        '**Матеріали й права.** Свої матеріали ти зберігаєш за собою. Завантажуй і публікуй лише те, на що маєш права: тексти, персонажів, зображення, портрети-референси. Дотримуйся ліцензій і зазначення авторства. Фанатські історії за чужими світами допустимі, якщо не порушують права, але позначка «фанатське» сама по собі дозволом не є. Публікуючи матеріал, ти надаєш Dreamwalk невиключне право зберігати, показувати й обробляти його (зокрема надсилати ШІ-провайдеру) в обсязі, потрібному для роботи сервісу.',
        '**Зображення в історіях.** Якщо зображення показано в публічній історії, це не означає, що його можна копіювати чи переробляти. Користуйся дозволами бібліотеки ассетів. Відкликання дозволу діє на нові використання; уже завантажені копії при цьому не зникають.',
        '**ШІ.** ШІ може помилятися й видавати вигадане за факти. Відповіді персонажів — частина гри, а не порада щодо здоров’я, права чи фінансів. Перевіряй згенероване перед публікацією: ми не гарантуємо його унікальність і відсутність чужих прав. Які дані отримують ШІ-провайдери, написано в політиці конфіденційності.',
        `**Скарги й модерація.** Про порушення можна повідомити кнопкою «Повідомити про порушення» або листом на ${email} із посиланням на матеріал і описом проблеми. Правовласник указує, що саме й на якій підставі порушено. Ми можемо приховати або видалити матеріал і обмежити акаунт. Рішення можна оскаржити листом на ту саму адресу.`,
        '**Наслідки порушень.** Ми можемо попередити автора, приховати матеріал, обмежити функції або закрити акаунт. За тяжкі порушення, наприклад експлуатацію дітей чи погрози, доступ закривається одразу, а за потреби ми передаємо відомості правоохоронним органам.',
        '**Іскри та платежі.** Платних функцій і прийому платежів зараз немає. Іскри — внутрішні одиниці для ШІ-генерації; демо-баланс не є грошима, не купується, не обмінюється на гроші й не повертається. Якщо платні функції з’являться, умови ми опублікуємо заздалегідь.',
        '**Відповідальність і зміни.** Сервіс надається «як є», без гарантії безперебійної роботи. У межах, дозволених законом, ми не відповідаємо за непрямі збитки. За порушення правил ми можемо обмежити або закрити доступ. До цих правил застосовується законодавство України.',
      ],
    },
    '/privacy': {
      title: 'Політика конфіденційності',
      paragraphs: [
        `**Коротко.** Ми збираємо лише те, що потрібно для роботи Dreamwalk, не продаємо дані й не показуємо рекламу. Відповідальний за дані — ${operator} (Україна), звернення: ${email}.`,
        '**Які дані ми отримуємо.** Дані акаунта: email, ім’я, хеш пароля, профіль і налаштування. Під час входу через Google — email, ім’я та ідентифікатор Google; пароль Google ми не отримуємо. Твої матеріали: історії, герої, NPC і зображення. Ігрові дані: дії, повідомлення, стан гри та пам’ять персонажів. Технічні дані: сесії, IP-адреса й час запитів для безпеки та захисту від зловживань, облік Іскор.',
        '**Навіщо ми це використовуємо.** Щоб працювали акаунт, гра й студія, надсилалися листи (підтвердження, сповіщення), діяли захист від зловживань і модерація, а також щоб розглядати звернення. Для цього достатньо даних вище, більше ми не збираємо.',
        '**Кому дані передаються.** Сайт розміщено на Vercel, API й базу даних — на Railway; листи надсилає Brevo; вхід через Google забезпечує Google. Сервери цих сервісів можуть бути за межами України. Для генерації тексту ми використовуємо OpenRouter, який передає запит обраній моделі стороннього провайдера; список моделей змінюється. Якщо ввімкнено генерацію зображень, запит надходить обраному провайдеру зображень. Іншим третім особам дані ми не продаємо.',
        '**Що отримує ШІ.** Під час генерації провайдеру надходять потрібні фрагменти тексту історії, контекст розмови та вибрані зображення. Приватна історія не означає, що передачі немає. Правила зберігання й навчання в провайдерів різні: ми намагаємося обирати моделі, які не використовують запити для навчання, але гарантувати цього не можемо. Не вводь у гру та в історії документи, паролі й чутливі дані про себе та інших людей.',
        '**Cookies й аналітика.** Зараз ми використовуємо лише необхідне: cookie сесії та збережені в браузері тему й мову. Якщо підключимо аналітику відвідуваності, повідомимо про це тут і, де потрібно, попросимо згоду.',
        '**Безпека даних.** Паролі зберігаються лише у вигляді хеша, з’єднання із сайтом шифрується (HTTPS), доступ до даних обмежений ролями. Жоден сервіс не захищений повністю; про значний витік, що стосується твоїх даних, ми повідомимо.',
        '**Як довго ми зберігаємо дані.** Поки існує акаунт. Після видалення акаунта сесії завершуються, а профіль знеособлюється одразу; решту особистих даних ми видаляємо з робочої бази протягом 30 днів. Резервні копії перезаписуються в міру ротації. Облікові записи та підсумки спільної гри з іншими людьми можуть залишитися у знеособленому вигляді. Технічні журнали зберігаються обмежений час, не довше, ніж потрібно для безпеки.',
        `**Твої права.** У налаштуваннях можна запросити експорт даних (готовий експорт доступний для завантаження сім днів), завершити всі сесії та видалити акаунт. За адресою ${email} можна попросити виправити дані, відкликати згоду або видалити їх; відповімо протягом 30 днів. Якщо ти перебуваєш у ЄС чи ЄЕЗ, тобі також доступні права за GDPR, зокрема скарга до наглядового органу.`,
        '**Вік і зміни.** Dreamwalk призначений для людей від 14 років; якщо ми дізнаємося про акаунт молодшого користувача, ми його закриємо. У разі суттєвих змін ми оновимо цю сторінку й дату редакції.',
      ],
    },
  },
  en: {
    '/about': {
      title: 'About Dreamwalk',
      paragraphs: [
        '**Dreamwalk is growing.** Some features may not be available to everyone and can change over time.',
        'Dreamwalk is a platform where a player and an AI tell a visual story together. An author sets the opening of the world and its rules, and the story carries on in play: new events, characters and places appear, and the artwork follows what has already happened.',
        'Pick an adventure from the catalogue, create your hero and play alone or with friends. Characters remember conversations, and the game engine keeps the story state and keeps the world consistent. An AI can make mistakes, so the engine, not the AI, has the final word on what happened.',
        'In the studio an author creates a story, locations, characters and drawn illustrations. A story can stay private, be shared by invitation or be proposed for the public catalogue after review. Image rights stay with the image’s author: other people’s images may not be used without permission.',
        `**Who is behind it.** Dreamwalk is developed by ${operator} (Ukraine). Questions, complaints and requests: ${email}.`,
      ],
    },
    '/terms': {
      title: 'Dreamwalk Rules',
      paragraphs: [
        '**In short.** These are the rules for using Dreamwalk (www.dreamwalk.online). By using the service you accept them; if you disagree, please do not use it. We may update the rules: the edition on this page applies.',
        `**Who we are.** The service is provided by ${operator}, Ukraine. You can reach us at ${email}.`,
        '**Age.** Dreamwalk is for people aged 14 and over. An author sets the age category of a public story — 14+, 16+ or 18+ — and is responsible for its content matching it. Do not open stories whose category is above your age. We may change the category or hide a story that does not match it.',
        '**Account and security.** Keep your access private and do not use anyone else’s account. Do not try to reach other people’s private material. Do not upload harmful files, send spam, bypass limits or scrape the service automatically.',
        '**What is not allowed.** Any exploitation or sexualisation of children, including fictional characters shown or described as children. Instructions that help cause real harm to people. Harassment and bullying. Hate directed at people because of race, nationality, religion, sex, orientation or disability. Dark themes are fine in a fictional story as long as it does not turn into instructions, hate propaganda or harassment; warn about sensitive themes in the story description.',
        '**Spam, deception and plagiarism.** Do not publish spam or scams, pass off someone else’s story as your own or mislead people. External links are fine only if they are safe: no malicious or phishing pages.',
        '**Self-harm and cruelty.** Do not publish material that encourages suicide, self-harm or eating disorders. Violence in fiction is acceptable, but not dwelling on real violence and not instructions. If you are struggling, reach out to people close to you or a support service.',
        '**Explicit content.** Sexual content is allowed only in AI text replies, only in stories rated 18+ and only with fictional adult characters. Explicit sexual images are not allowed.',
        '**Content and rights.** You keep your own material. Upload and publish only what you have the rights to: text, characters, images and portrait references. Follow licences and attribution. Fan stories set in other people’s worlds are acceptable if they do not infringe rights, but a “fan” label is not permission by itself. By publishing material you give Dreamwalk a non-exclusive right to store, display and process it (including sending it to an AI provider) as far as needed to run the service.',
        '**Images in stories.** An image shown in a public story is not permission to copy or rework it. Use the permissions of the asset library. Withdrawing a permission applies to new uses; copies already downloaded do not disappear.',
        '**AI.** An AI can make mistakes and present fiction as fact. Character replies are part of the game, not health, legal or financial advice. Check generated material before publishing it: we do not guarantee it is unique or free of third-party rights. What AI providers receive is described in the privacy policy.',
        `**Reports and moderation.** You can report a problem with the “Report a violation” button or by writing to ${email} with a link to the material and a description. A rights holder should say what is infringed and on what basis. We may hide or remove material and restrict an account. You can contest a decision by writing to the same address.`,
        '**Consequences of violations.** We may warn an author, hide material, restrict features or close an account. For serious violations, such as child exploitation or threats, access is closed at once and, where necessary, we pass information to law enforcement.',
        '**Sparks and payments.** There are currently no paid features or payments. Sparks are internal units for AI generation; the demo balance is not money, cannot be bought, exchanged for money or refunded. If paid features appear, we will publish their terms in advance.',
        '**Liability and changes.** The service is provided “as is”, with no guarantee of uninterrupted operation. To the extent the law allows, we are not liable for indirect losses. We may restrict or close access for breaking the rules. These rules are governed by the law of Ukraine.',
      ],
    },
    '/privacy': {
      title: 'Privacy Policy',
      paragraphs: [
        `**In short.** We collect only what Dreamwalk needs to work, we do not sell data and we do not show ads. The party responsible for data is ${operator} (Ukraine); contact: ${email}.`,
        '**What data we get.** Account data: email, name, a password hash, profile and settings. When you sign in with Google: email, name and Google ID; we never receive your Google password. Your material: stories, heroes, NPCs and images. Game data: actions, messages, game state and character memory. Technical data: sessions, IP address and request times for security and abuse prevention, and Sparks accounting.',
        '**Why we use it.** To run the account, the game and the studio, send emails (confirmation, notifications), prevent abuse, moderate content and handle requests. The data above is enough for this; we do not collect more.',
        '**Who receives data.** The site is hosted on Vercel, the API and database on Railway; Brevo sends emails; Google provides sign-in. The servers of these services may be outside Ukraine. For text generation we use OpenRouter, which passes the request to the chosen model of a third-party provider; the list of models changes. If image generation is enabled, the request goes to the chosen image provider. We do not sell data to other third parties.',
        '**What the AI receives.** When generating, the provider receives the needed fragments of story text, conversation context and selected images. A private story does not mean there is no such transfer. Providers’ storage and training rules differ: we try to pick models that do not use requests for training, but we cannot guarantee it. Do not enter documents, passwords or sensitive data about yourself or others into the game or stories.',
        '**Cookies and analytics.** We currently use only what is necessary: a session cookie and your theme and language saved in the browser. If we add traffic analytics we will say so here and, where required, ask for consent.',
        '**Data security.** Passwords are stored only as a hash, the connection to the site is encrypted (HTTPS) and access to data is limited by role. No service is fully secure; if a significant breach affects your data, we will tell you.',
        '**How long we keep data.** While the account exists. When an account is deleted, sessions end and the profile is anonymised at once; we delete other personal data from the working database within 30 days. Backups are overwritten as they rotate. Accounting records and the outcomes of shared play with other people may remain in anonymised form. Technical logs are kept for a limited time, no longer than needed for security.',
        `**Your rights.** In settings you can request a data export (a finished export can be downloaded for seven days), end all sessions and delete your account. Write to ${email} to ask us to correct data, withdraw consent or erase it; we reply within 30 days. If you are in the EU or EEA you also have GDPR rights, including the right to complain to a supervisory authority.`,
        '**Age and changes.** Dreamwalk is for people aged 14 and over; if we learn that an account belongs to someone younger, we close it. If something changes materially, we update this page and its edition date.',
      ],
    },
  },
} as const;

export const legalEditionLabel = {
  ru: 'РЕДАКЦИЯ ОТ 10 НОЯБРЯ 2026',
  uk: 'РЕДАКЦІЯ ВІД 10 ЛИСТОПАДА 2026',
  en: 'EDITION OF NOVEMBER 10, 2026',
} as const;
