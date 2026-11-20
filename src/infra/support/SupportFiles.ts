/**
 * Пути файлов поддержки поставщика в выгрузке конфигурации (корпус example/2.20): `Ext/ParentConfigurations.bin`
 * описывает поставщиков и правила поддержки, `Ext/ParentConfigurations/<Поставщик>.cf` — сами конфигурации
 * поставщиков (до гигабайта). Одна файловая запись CDI `Configuration.<Имя>.ParentConfigurations` покрывает все.
 * Пути — POSIX от корня выгрузки, ровно в регистре платформы: от них зависит шлюз скачивания при импорте.
 */

/** Имя части корня конфигурации в списке изменений агента и в файле версий. */
export const PARENT_CONFIGURATIONS_PART = 'ParentConfigurations';

/** Описание поставщиков и правил поддержки. */
export const PARENT_CONFIGURATIONS_BIN_REL = 'Ext/ParentConfigurations.bin';

/** Каталог файлов `.cf` поставщиков. */
export const PARENT_CONFIGURATIONS_DIR_REL = 'Ext/ParentConfigurations';
