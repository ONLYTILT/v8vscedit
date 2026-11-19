import * as vscode from 'vscode';
import { describeError } from '../../../../infra/agent';
import { runWhenConfigurationOperationIdle } from '../configurationOperationLock';
import { disposeCachedAgentOperationServices } from './AgentServiceRegistry';

/** Структурное подмножество `vscode.ConfigurationChangeEvent`: проверяется без настоящего события. */
export interface ConfigurationChangeLike {
  affectsConfiguration(section: string): boolean;
}

/** Разделы, из которых строится запись реестра сервисов агента (место, адрес, логин, параметры передачи). */
export function affectsAgentServices(event: ConfigurationChangeLike): boolean {
  return event.affectsConfiguration('v8vscedit.agent') || event.affectsConfiguration('v8vscedit.remote');
}

/**
 * Сброс кэша сервисов агента при смене его настроек: закэшированная запись держит SSH/SFTP к
 * прежнему адресу и с прежними параметрами, и без сброса новые настройки не применились бы до
 * перезапуска VS Code. Сброс откладывается до конца идущей операции с конфигурацией — закрыть
 * соединение под ней значит оборвать выгрузку/загрузку на середине. Несколько изменений за одну
 * операцию дают один сброс.
 */
export function registerAgentSettingsWatcher(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel): void {
  let resetScheduled = false;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsAgentServices(event) || resetScheduled) {
        return;
      }
      resetScheduled = true;
      runWhenConfigurationOperationIdle(() => {
        resetScheduled = false;
        outputChannel.appendLine('[agent] Настройки агента конфигуратора изменены: подключения к агенту будут созданы заново.');
        // Защитная ветка: освобождение записей на штатных путях не отказывает (зафейленный старт
        // реестр глотает сам), но отказ без catch стал бы необработанным отклонением промиса.
        /* c8 ignore next 3 */
        disposeCachedAgentOperationServices().catch((error: unknown) => {
          outputChannel.appendLine(`[agent][warn] Не удалось закрыть прежние подключения к агенту: ${describeError(error)}`);
        });
      });
    })
  );
}
