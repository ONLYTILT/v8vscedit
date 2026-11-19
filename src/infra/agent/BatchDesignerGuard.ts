import type { AgentOperationHooks, DesignerAgentInfoBaseSession } from './AgentOperationService';

export interface InfoBaseReleaseOptions {
  readonly hooks?: AgentOperationHooks;
  /**
   * Отключить даже без известного подключения: внешний агент, найденный на порту после
   * перезапуска VS Code, может держать базу, о чём кэш расширения не знает.
   */
  readonly force?: boolean;
}

/**
 * Отпускает информационную базу у агента конфигуратора, если она (возможно) подключена.
 * Возвращает `true`, если `disconnect-ib` был отправлен. Ошибка пробрасывается: пакетный
 * Конфигуратор при подключённом агенте упрётся в блокировку базы, запускать его бессмысленно.
 *
 * Состояние «подключено» здесь НЕ проверяется: сессия решает это внутри своей очереди.
 * Проверка снаружи гонялась бы с уже поставленным в очередь `reconnectInfoBase` (например,
 * после закрытия интерактивного Конфигуратора) — база осталась бы подключённой.
 */
export async function releaseInfoBase(
  session: DesignerAgentInfoBaseSession | undefined,
  options: InfoBaseReleaseOptions = {}
): Promise<boolean> {
  if (!session) {
    return false;
  }
  return session.disconnectInfoBase(options.hooks, { force: options.force });
}

/**
 * Единственная точка «отпустить базу перед пакетной операцией». Переподключение после
 * операции намеренно не делается: оно ленивое, при следующей агентской операции, — иначе
 * агент снова занял бы базу, которая может понадобиться следующей пакетной операции.
 */
export async function runWithInfoBaseReleased<T>(
  session: DesignerAgentInfoBaseSession | undefined,
  op: () => Promise<T>,
  options: InfoBaseReleaseOptions = {}
): Promise<T> {
  await releaseInfoBase(session, options);
  return op();
}
