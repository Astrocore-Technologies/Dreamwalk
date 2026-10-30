CREATE TABLE platform_settings(key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO platform_settings(key,value) VALUES('taxonomy','{"genres":["Тайна","Фэнтези","Приключение","Уютное фэнтези","Научная фантастика"],"tags":["Загадки","Тайны","Атмосфера","Исследование","Магия","Море","Выбор","Отношения","Уют"]}');
CREATE UNIQUE INDEX one_requested_export_per_user ON data_requests(user_id,kind) WHERE status='requested';
