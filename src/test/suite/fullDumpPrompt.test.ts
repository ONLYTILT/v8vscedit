import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentFullDumpRequest } from '../../infra/agent/AgentOperationService';
import { SERVER_DUMP_POLICY, type ImportArchiveReason } from '../../infra/agent/sync/SyncPlanner';
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

const REASONS: ImportArchiveReason[] = ['mirror-empty', 'full-dump', 'unrecognized', 'unresolved-objects', 'over-threshold', 'sparse-mirror-dirty', 'sparse-removed-parts'];

function request(overrides: Partial<AgentFullDumpRequest> = {}): AgentFullDumpRequest {
  return {
    targetKind: 'cf',
    targetName: 'Бухгалтерия КОРП',
    projectDir: path.join(os.tmpdir(), 'project', 'src', 'cf'),
    operation: 'import',
    reason: 'full-dump',
    reasonText: 'в базе удалены или переименованы объекты (агент сообщил FullDump)',
    download: true,
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

suite('promptFullDump: загрузка изменений (operation = load)', () => {
  let restore: (() => void) | undefined;
  teardown(() => { restore?.(); restore = undefined; });

  function stubWarning(answer: string | undefined): { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const original = win.showWarningMessage;
    win.showWarningMessage = (...args: unknown[]) => { calls.push(args); return Promise.resolve(answer); };
    restore = () => { win.showWarningMessage = original; };
    return { calls };
  }

  const loadRequest = (): AgentFullDumpRequest => request({
    operation: 'load',
    reason: 'mirror-empty',
    reasonText: 'зеркало агента пусто',
  });

  test('текст: «Загрузка изменений», имя цели, подготовка зеркала, скачивания нет, десятки минут; без инструкции ручной выгрузки', async () => {
    const { calls } = stubWarning(undefined);
    await promptFullDump(loadRequest());
    const text = [String(calls[0][0]), (calls[0][1] as { detail?: string }).detail ?? ''].join('\n');
    assert.ok(text.includes('Загрузка изменений'), text);
    assert.ok(text.includes('Бухгалтерия КОРП'), text);
    assert.match(text, /зеркал/);
    assert.match(text, /Скачивания нет/);
    assert.match(text, /десятки минут/);
    assert.ok(!text.includes('ConfigDumpInfo.xml'), 'ручная выгрузка проекта к загрузке не относится');
    assert.ok(!text.includes('Импорт «'), 'текст импорта не используется');
  });

  test('диалог модальный; кнопки «Выгрузить на сервере» и «Отмена» в этом порядке', async () => {
    const { calls } = stubWarning(undefined);
    await promptFullDump(loadRequest());
    assert.strictEqual((calls[0][1] as { modal?: boolean }).modal, true);
    assert.deepStrictEqual(calls[0].slice(2), ['Выгрузить на сервере', 'Отмена']);
  });

  test('«Выгрузить на сервере» → dump', async () => {
    stubWarning('Выгрузить на сервере');
    assert.strictEqual(await promptFullDump(loadRequest()), 'dump');
  });

  for (const answer of ['Отмена', undefined, 'иное']) {
    test(`ответ ${JSON.stringify(answer)} → cancel`, async () => {
      stubWarning(answer);
      assert.strictEqual(await promptFullDump(loadRequest()), 'cancel');
    });
  }

  test('operation = import — прежние кнопки и текст (регресс)', async () => {
    const { calls } = stubWarning(undefined);
    await promptFullDump(request());
    assert.ok(String(calls[0][0]).startsWith('Импорт «'));
    assert.deepStrictEqual(calls[0].slice(2), [DUMP_LABEL, MANUAL_LABEL]);
  });
});

/**
 * Запасной путь «FullDump без архива» (plan-fulldump-avoid.md, Т8): перезапись зеркала на сервере — выгрузка долгая,
 * но скачиваются только изменённые файлы (`download: false`). Свой текст и свои кнопки; закрытие — отказ.
 */
suite('promptFullDump: перезапись зеркала на сервере (download = false)', () => {
  let restore: (() => void) | undefined;
  teardown(() => { restore?.(); restore = undefined; });

  const REWRITE_LABEL = 'Перезаписать зеркало на сервере';

  function stubWarning(answer: string | undefined): { calls: unknown[][] } {
    const calls: unknown[][] = [];
    const original = win.showWarningMessage;
    win.showWarningMessage = (...args: unknown[]) => { calls.push(args); return Promise.resolve(answer); };
    restore = () => { win.showWarningMessage = original; };
    return { calls };
  }

  const rewriteRequest = (overrides: Partial<AgentFullDumpRequest> = {}): AgentFullDumpRequest => request({
    reason: 'mirror-rewrite',
    reasonText: SERVER_DUMP_POLICY['mirror-rewrite'].text,
    download: false,
    ...overrides,
  });
  const textOf = (call: unknown[]): string => [String(call[0]), (call[1] as { detail?: string } | undefined)?.detail ?? ''].join('\n');

  test('диалог модальный; кнопки «Перезаписать зеркало на сервере» и «Отмена» в этом порядке', async () => {
    const { calls } = stubWarning(undefined);
    await promptFullDump(rewriteRequest());
    assert.strictEqual(calls.length, 1);
    assert.strictEqual((calls[0][1] as { modal?: boolean }).modal, true);
    assert.deepStrictEqual(calls[0].slice(2), [REWRITE_LABEL, 'Отмена']);
  });

  test('«Перезаписать зеркало на сервере» → dump', async () => {
    stubWarning(REWRITE_LABEL);
    assert.strictEqual(await promptFullDump(rewriteRequest()), 'dump');
  });

  for (const answer of ['Отмена', undefined, 'иное', DUMP_LABEL, MANUAL_LABEL]) {
    test(`ответ ${JSON.stringify(answer)} → cancel (закрытие диалога и чужие кнопки — отказ)`, async () => {
      stubWarning(answer);
      assert.strictEqual(await promptFullDump(rewriteRequest()), 'cancel');
    });
  }

  for (const targetKind of ['cf', 'cfe'] as const) {
    test(`текст (${targetKind}): имя цели и причина; скачиваются только изменённые файлы, выгрузка на сервере долгая; без ручной выгрузки проекта`, async () => {
      const { calls } = stubWarning(undefined);
      await promptFullDump(rewriteRequest({ targetKind, targetName: targetKind === 'cf' ? 'Бухгалтерия КОРП' : 'Расширение «Доработки»' }));
      const text = textOf(calls[0]);
      assert.ok(text.includes(targetKind === 'cf' ? 'Бухгалтерия КОРП' : 'Расширение «Доработки»'), text);
      assert.ok(text.includes(SERVER_DUMP_POLICY['mirror-rewrite'].text), text);
      assert.match(text, /только изменённые файлы/);
      assert.match(text, /долг/);
      assert.ok(!text.includes('ConfigDumpInfo.xml'), 'ручная замена каталога выгрузки не предлагается');
      assert.ok(!text.includes('Выгружу вручную'));
    });
  }

  test('download = true на тех же причинах — прежний вопрос импорта (регресс): кнопки и текст как раньше', async () => {
    const { calls } = stubWarning(undefined);
    await promptFullDump(request({ reason: 'sparse-removed-parts', download: true }));
    assert.ok(String(calls[0][0]).startsWith('Импорт «'));
    assert.deepStrictEqual(calls[0].slice(2), [DUMP_LABEL, MANUAL_LABEL]);
  });
});
