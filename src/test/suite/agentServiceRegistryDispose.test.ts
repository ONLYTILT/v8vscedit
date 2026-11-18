import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import {
  disposeCachedAgentOperationServices,
  ensureAgentService,
  type CachedAgentService,
} from '../../ui/commands/ext/agent/AgentServiceRegistry';

/**
 * Остановка расширения во время незавершённого старта агентского сервиса: промис старта, который
 * отказывает уже после того, как остановка взяла его из кэша, не должен ронять остановку — остальные
 * сервисы закрываются как обычно.
 */
suite('AgentServiceRegistry: остановка при отказавшем старте', () => {
  teardown(async () => { await disposeCachedAgentOperationServices(); });

  test('старт отказывает после начала остановки: остановка завершается, исправный сервис закрыт', async () => {
    let rejectStart: (error: Error) => void = () => undefined;
    const failing = ensureAgentService(path.join(os.tmpdir(), 'v8-registry-failing'), () => new Promise<CachedAgentService>((_resolve, reject) => {
      rejectStart = reject;
    }));
    failing.catch(() => undefined);

    const closed: string[] = [];
    // Старт отказывает изнутри закрытия соседнего сервиса: к этому моменту остановка уже взяла оба
    // промиса из кэша — детерминированно, без расчёта на тайминги.
    const healthy = {
      service: { dispose: () => { closed.push('service'); rejectStart(new Error('агент не запустился')); return Promise.resolve(); } },
      sessions: { disposeAll: () => { closed.push('sessions'); return Promise.resolve(); } },
    } as unknown as CachedAgentService;
    await ensureAgentService(path.join(os.tmpdir(), 'v8-registry-healthy'), () => Promise.resolve(healthy));

    await disposeCachedAgentOperationServices();

    assert.deepStrictEqual(closed, ['service', 'sessions']);
  });
});
