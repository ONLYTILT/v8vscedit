import * as assert from 'assert';
import * as vscode from 'vscode';
import type { AgentOrphanFilesRequest } from '../../infra/agent/AgentOperationService';
import { promptOrphanRemoval } from '../../ui/commands/ext/agent/orphanFilesPrompt';

/**
 * Вопрос об удалении «осиротевших» файлов выгрузки проекта (plan-archive-avoid.md §3.7): объекты удалены в
 * базе до ручной выгрузки, а их файлы остались в P от прежней выгрузки. Удаление файлов — только по явному
 * согласию: Esc означает «не удалять».
 */

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;
const DELETE_LABEL = 'Удалить файлы';

const request = (owners: string[]): AgentOrphanFilesRequest => ({
  targetName: 'Бухгалтерия КОРП',
  owners,
  files: owners.flatMap((owner) => [`Catalogs/${owner}.xml`, `Catalogs/${owner}/Ext/ObjectModule.bsl`]),
});
const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `Catalog.Объект${String(i + 1).padStart(2, '0')}`);

suite('promptOrphanRemoval', () => {
  let restore: (() => void) | undefined;
  teardown(() => { restore?.(); restore = undefined; });

  function stubWarning(answer: string | undefined): { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const original = win.showWarningMessage;
    win.showWarningMessage = (...args: unknown[]) => { calls.push(args); return Promise.resolve(answer); };
    restore = () => { win.showWarningMessage = original; };
    return { calls };
  }

  const detailOf = (call: unknown[]): string => (call[1] as { detail?: string } | undefined)?.detail ?? '';

  test('кнопка «Удалить файлы» → true', async () => {
    stubWarning(DELETE_LABEL);
    assert.strictEqual(await promptOrphanRemoval(request(names(2))), true);
  });

  test('закрытие диалога (Esc) → false', async () => {
    stubWarning(undefined);
    assert.strictEqual(await promptOrphanRemoval(request(names(2))), false);
  });

  test('любой иной ответ → false, а не молчаливое удаление', async () => {
    stubWarning('Отмена');
    assert.strictEqual(await promptOrphanRemoval(request(names(2))), false);
  });

  test('диалог модальный; единственная кнопка — «Удалить файлы»', async () => {
    const { calls } = stubWarning(undefined);
    await promptOrphanRemoval(request(names(2)));
    assert.strictEqual(calls.length, 1);
    assert.strictEqual((calls[0][1] as { modal?: boolean }).modal, true);
    assert.deepStrictEqual(calls[0].slice(2), [DELETE_LABEL]);
  });

  test('сообщение: имя цели и число объектов', async () => {
    const { calls } = stubWarning(undefined);
    await promptOrphanRemoval(request(names(3)));
    const message = String(calls[0][0]);
    assert.ok(message.includes('Бухгалтерия КОРП'), message);
    assert.match(message, /\b3\b/);
    assert.match(message, /нет в базе/);
  });

  test('до 20 владельцев — все в detail, без «и ещё»', async () => {
    const { calls } = stubWarning(undefined);
    await promptOrphanRemoval(request(names(20)));
    const detail = detailOf(calls[0]);
    for (const name of names(20)) {
      assert.ok(detail.includes(name), name);
    }
    assert.doesNotMatch(detail, /и ещё/);
  });

  test('21 владелец → в detail первые 20 и «и ещё 1»', async () => {
    const { calls } = stubWarning(undefined);
    await promptOrphanRemoval(request(names(21)));
    const detail = detailOf(calls[0]);
    for (const name of names(20)) {
      assert.ok(detail.includes(name), name);
    }
    assert.ok(!detail.includes(names(21)[20]), 'двадцать первый не показан поимённо');
    assert.match(detail, /и ещё 1\b/);
  });

  test('100 владельцев → «и ещё 80»', async () => {
    const { calls } = stubWarning(undefined);
    await promptOrphanRemoval(request(names(100)));
    assert.match(detailOf(calls[0]), /и ещё 80\b/);
  });
});
