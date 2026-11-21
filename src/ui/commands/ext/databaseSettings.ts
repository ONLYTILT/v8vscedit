import * as vscode from 'vscode';

/**
 * Настройка `v8vscedit.configuration.updateDatabaseAfterLoad` — режим НЕЯВНЫХ загрузок («Обновить изменённые
 * конфигурации», шаг загрузки в цепочках хранилища). Общая для агентского и пакетного режима, поэтому живёт
 * отдельно от настроек агента. Явные команды узла от неё не зависят.
 *
 * Только явное `false` отключает обновление БД: прежнее поведение (загрузка всегда с UpdateDBCfg) не должно
 * меняться от опечатки в settings.json.
 */
export function readUpdateDatabaseAfterLoad(): boolean {
  return vscode.workspace.getConfiguration('v8vscedit').get<unknown>('configuration.updateDatabaseAfterLoad', true) !== false;
}

/** Пояснение к пункту диалога, который загружает правки: при выключенной настройке БД не обновится. */
export function withLoadModeNote(detail: string, updateDatabaseAfterLoad: boolean): string {
  return updateDatabaseAfterLoad
    ? detail
    : `${detail} (конфигурация БД не обновляется — настройка updateDatabaseAfterLoad)`;
}
