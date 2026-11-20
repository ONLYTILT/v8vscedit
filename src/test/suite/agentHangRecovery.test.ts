/**
 * Решение после зависания агента на короткой команде (infra/agent/AgentHangRecovery.ts, ФАКТ Э29, П2):
 * зависший процесс жив, но сломан до перезапуска; повтор команды бесполезен. Свой локальный процесс —
 * перезапуск; чужой локальный и удалённый — просьба перезапустить.
 */
import * as assert from 'assert';
import { AgentCommandError, AgentConnectionLostError, decideAgentHangRecovery } from '../../infra/agent';

const VERB = 'config extensions properties get';
const hang = () => new AgentConnectionLostError(VERB, 'no-response', undefined, { deadlineMs: 30_000 });

suite('decideAgentHangRecovery', () => {
  const notHang: [string, unknown][] = [
    ['обрыв канала', new AgentConnectionLostError('config dump-cfg', 'closed')],
    ['ошибка клиента', new AgentConnectionLostError('config dump-cfg', 'error', 'ECONNRESET')],
    ['отказ агента', new AgentCommandError('x', 'config load-cfg')],
    ['обычная ошибка', new Error('x')],
  ];
  for (const [title, error] of notHang) {
    test(`не зависание (${title}) → undefined`, () => {
      assert.strictEqual(decideAgentHangRecovery(error, { location: 'local', ownsProcess: true }), undefined);
    });
  }

  test('локальный агент, запущенный расширением → перезапуск своего процесса, повтор операции — человеку', () => {
    const decision = decideAgentHangRecovery(hang(), { location: 'local', ownsProcess: true });
    assert.strictEqual(decision?.restartOwnProcess, true);
    assert.ok(decision.text.includes(`«${VERB}»`) && decision.text.includes('запущен заново') && decision.text.includes('повторите'), decision.text);
  });

  test('локальный агент, запущенный пользователем → без перезапуска, текст E2 с просьбой перезапустить', () => {
    const decision = decideAgentHangRecovery(hang(), { location: 'local', ownsProcess: false });
    assert.strictEqual(decision?.restartOwnProcess, false);
    assert.ok(decision.text.includes('не ответил за 30 с') && decision.text.includes('перезапустите агента'), decision.text);
  });

  test('удалённый агент → без перезапуска (процесс чужой), просьба перезапустить агента на сервере', () => {
    const decision = decideAgentHangRecovery(hang(), { location: 'remote', ownsProcess: true });
    assert.strictEqual(decision?.restartOwnProcess, false);
    assert.ok(decision.text.includes('на сервере') && decision.text.includes('перезапустите агента на сервере'), decision.text);
  });
});
