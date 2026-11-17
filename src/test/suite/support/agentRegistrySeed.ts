/**
 * Подсев кэша `AgentServiceRegistry` готовой записью с настоящим `AgentOperationService`
 * поверх фейкового транспорта (внешний агент 1С недоступен): через эту запись UI-тесты Э4
 * наблюдают `disconnect-ib` без реального SSH. Запись кладётся штатным `ensureAgentService`,
 * поэтому синхронный `getCachedAgentOperationService` видит её так же, как боевую.
 */
import { AgentOperationService } from '../../../infra/agent';
import { ensureAgentService, type CachedAgentService } from '../../../ui/commands/ext/agent/AgentServiceRegistry';
import { ScriptedFactory, type TransportBehavior } from './agentInfoBaseFakes';

export interface SeededAgent {
  readonly factory: ScriptedFactory;
  readonly service: AgentOperationService;
  readonly entry: CachedAgentService;
}

/** Собирает запись реестра; `connected: true` — база уже подключена (connect-ib выполнен). */
export async function makeAgentEntry(
  workspaceRoot: string,
  options: { connected: boolean; behavior?: TransportBehavior }
): Promise<SeededAgent> {
  const factory = new ScriptedFactory(options.behavior);
  const service = new AgentOperationService(workspaceRoot, factory);
  if (options.connected) {
    await service.reconnectInfoBase();
    factory.log.length = 0;
  }
  // Приведение: поля записи, добавляемые Э4 (transportOptions и т.п.), тесту подсева не нужны.
  const entry = {
    service,
    sessions: { disposeAll: () => Promise.resolve() },
  } as unknown as CachedAgentService;
  return { factory, service, entry };
}

export async function seedCachedAgentService(
  workspaceRoot: string,
  options: { connected: boolean; behavior?: TransportBehavior }
): Promise<SeededAgent> {
  const seeded = await makeAgentEntry(workspaceRoot, options);
  await ensureAgentService(workspaceRoot, () => Promise.resolve(seeded.entry));
  return seeded;
}
