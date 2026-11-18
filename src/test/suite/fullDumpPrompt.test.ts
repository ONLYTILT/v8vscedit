import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentFullDumpRequest } from '../../infra/agent/AgentOperationService';
import type { ImportArchiveReason } from '../../infra/agent/sync/SyncPlanner';
import { promptFullDump } from '../../ui/commands/ext/agent/fullDumpPrompt';

/**
 * Вопрос перед полной серверной выгрузкой при импорте (plan-archive-avoid.md §4, ui). Это вопрос с ответом,
 * а не уведомление: операция ждёт решения, запрет №18 (уведомления без `await` внутри эксклюзивной секции)
 * его не касается. Закрытие диалога — отмена: дорогая выгрузка без явного согласия не запускается.
 */

type Fn = (...args: never[]) => unknown;
const win = vscode.window as unknown as Record<string, Fn>;

const DUMP_LABEL = 'Полная выгрузка на сервере';
const MANUAL_LABEL = 'Выгружу вручную';

const REASONS: ImportArchiveReason[] = ['mirror-empty', 'full-dump', 'unrecognized', 'unresolved-objects', 'over-threshold', 'sparse-mirror-dirty'];

function request(overrides: Partial<AgentFullDumpRequest> = {}): AgentFullDumpRequest {
  return {
    targetKind: 'cf',
    targetName: 'Бухгалтерия КОРП',
    projectDir: path.join(os.tmpdir(), 'project', 'src', 'cf'),
    reason: 'full-dump',
    reasonText: 'в базе удалены или переименованы объекты (агент сообщил FullDump)',
    ...overrides,
  };
}

suite('promptFullDump', () => {
  let restore: (() => void) | undefined;
  teardown(() => { restore?.(); restore = undefined; });

  function stubWarning(answer: string | undefined): { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const original = win.showWarningMessage;
    win.showWarningMessage = (...args: unknown[]) => { calls.push(args); return Promise.resolve(answer); };
    restore = () => { win.showWarningMessage = original; };
    return { calls };
  }

  const textOf = (call: unknown[]): string => [String(call[0]), (call[1] as { detail?: string } | undefined)?.detail ?? ''].join('\n');

  test('кнопка «Полная выгрузка на сервере» → dump', async () => {
    stubWarning(DUMP_LABEL);
    assert.strictEqual(await promptFullDump(request()), 'dump');
  });

  test('кнопка «Выгружу вручную» → cancel', async () => {
    stubWarning(MANUAL_LABEL);
    assert.strictEqual(await promptFullDump(request()), 'cancel');
  });

  test('закрытие диалога (Esc, undefined) → cancel', async () => {
    stubWarning(undefined);
    assert.strictEqual(await promptFullDump(request()), 'cancel');
  });

  test('любой иной ответ → cancel, а не молчаливая полная выгрузка', async () => {
    stubWarning('Отмена');
    assert.strictEqual(await promptFullDump(request()), 'cancel');
  });

  test('диалог модальный; ровно две кнопки в порядке «выгрузка на сервере», «выгружу вручную»', async () => {
    const { calls } = stubWarning(undefined);
    await promptFullDump(request());
    assert.strictEqual(calls.length, 1);
    assert.strictEqual((calls[0][1] as { modal?: boolean }).modal, true);
    assert.deepStrictEqual(calls[0].slice(2), [DUMP_LABEL, MANUAL_LABEL]);
  });

  for (const reason of REASONS) {
    for (const targetKind of ['cf', 'cfe'] as const) {
      test(`текст (${reason}, ${targetKind}): имя цели, текст причины, каталог проекта, ConfigDumpInfo.xml и инструкция ручной выгрузки`, async () => {
        const { calls } = stubWarning(undefined);
        const req = request({
          reason,
          targetKind,
          targetName: targetKind === 'cf' ? 'Бухгалтерия КОРП' : 'Расширение «Доработки»',
          reasonText: `причина-${reason}`,
        });
        await promptFullDump(req);
        const text = textOf(calls[0]);
        assert.ok(text.includes(req.targetName), text);
        assert.ok(text.includes(`причина-${reason}`), `причина в тексте: ${text}`);
        assert.ok(text.includes(req.projectDir), `каталог проекта: ${text}`);
        assert.ok(text.includes('ConfigDumpInfo.xml'), 'замена каталога «включая ConfigDumpInfo.xml»');
        assert.match(text, /полной выгрузк/i);
        assert.match(text, /вручную/i);
        assert.match(text, /иерархическ/i, 'формат ручной выгрузки');
        assert.match(text, /следующий импорт/i, 'сказано, что импорт предложит взять выгрузку за основу');
        assert.match(text, /десятки минут/);
      });
    }
  }
});
