/**
 * Фейки для тестов долгих MCP-вызовов (`McpMutationGate.wrapLongRunning`): `extra` обработчика
 * инструмента с записью уведомлений, управляемым отказом отправки и отменой; ожидание смены
 * миллисекунды часов.
 */
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { McpPulseNotification } from '../../../infra/mcp/McpRequestPulse';
import type { McpToolExtra } from '../../../ui/mcp/registration/McpMutationGate';

/** Фиктивный `extra` обработчика инструмента: запись уведомлений, управляемый отказ отправки, abort. */
export interface FakeExtra extends McpToolExtra {
  readonly notifications: McpPulseNotification[];
  readonly controller: AbortController;
  failSends: boolean;
}

export function fakeExtra(progressToken?: string | number, signal?: AbortController): FakeExtra {
  const controller = signal ?? new AbortController();
  const extra: FakeExtra = {
    _meta: progressToken === undefined ? undefined : { progressToken },
    signal: controller.signal,
    notifications: [],
    controller,
    failSends: false,
    sendNotification(notification: ServerNotification) {
      if (extra.failSends) {
        return Promise.reject(new Error('socket closed'));
      }
      // Шлюз шлёт только уведомления пульса: сужение типа для проверок теста.
      extra.notifications.push(notification as McpPulseNotification);
      return Promise.resolve();
    },
  };
  return extra;
}

/** Дожидается СЛЕДУЮЩЕЙ миллисекунды часов (ограниченный спин ≤ 1 мс): отличает «раньше» от «в тот же момент». */
export function waitForNextMillisecond(): void {
  const start = Date.now();
  while (Date.now() === start) {
    // спин: Date.now() сменится не позже чем через миллисекунду
  }
}
