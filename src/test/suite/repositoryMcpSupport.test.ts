import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CONFIGURATION_OPERATION_BUSY_MESSAGE,
  endConfigurationOperation,
  isConfigurationOperationRunning,
  runWithConfigurationOperationLockOrThrow,
  tryBeginConfigurationOperation,
} from '../../ui/commands/ext/configurationOperationLock';
import { resolveApplyTargetFromNode } from '../../ui/commands/ext/CfFileTarget';
import { MetadataNode } from '../../ui/tree/TreeNode';

/**
 * Общие опоры MCP-инструментов хранилища:
 *  - `runWithConfigurationOperationLockOrThrow` (`configurationOperationLock.ts`) — бросающий замок для
 *    MCP: у MCP нет тостов, занятый замок — исключение с `CONFIGURATION_OPERATION_BUSY_MESSAGE`;
 *  - `resolveApplyTargetFromNode` (`CfFileTarget.ts`) — цель `/UpdateDBCfg` по узлу, корень берётся из
 *    РЕАЛЬНОГО `Configuration.xml` узла (а не выводится из раскладки `src/cf`).
 */
suite('configurationOperationLock: runWithConfigurationOperationLockOrThrow', () => {
  teardown(async () => {
    if (isConfigurationOperationRunning()) {
      await endConfigurationOperation();
    }
  });

  test('замок свободен: операция выполняется ПОД замком, результат возвращается, замок освобождён после', async () => {
    let heldInside = false;
    const result = await runWithConfigurationOperationLockOrThrow(() => {
      heldInside = isConfigurationOperationRunning();
      return Promise.resolve('итог');
    });
    assert.strictEqual(result, 'итог');
    assert.strictEqual(heldInside, true);
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });

  test('замок занят: бросает CONFIGURATION_OPERATION_BUSY_MESSAGE, операция не запускается, чужой замок НЕ снят', async () => {
    assert.strictEqual(await tryBeginConfigurationOperation(), true);
    let ran = false;
    await assert.rejects(
      () => runWithConfigurationOperationLockOrThrow(() => { ran = true; return Promise.resolve(1); }),
      (error: Error) => error.message === CONFIGURATION_OPERATION_BUSY_MESSAGE
    );
    assert.strictEqual(ran, false);
    assert.strictEqual(isConfigurationOperationRunning(), true, 'чужой замок остался');
  });

  test('занятый замок не порождает тоста (в отличие от runWithConfigurationOperationLock)', async () => {
    const infos: string[] = [];
    const w = vscode.window as unknown as { showInformationMessage: unknown };
    const original = w.showInformationMessage;
    w.showInformationMessage = (message: string) => { infos.push(message); return Promise.resolve(undefined); };
    try {
      assert.strictEqual(await tryBeginConfigurationOperation(), true);
      await assert.rejects(() => runWithConfigurationOperationLockOrThrow(() => Promise.resolve(0)));
    } finally {
      w.showInformationMessage = original;
    }
    assert.deepStrictEqual(infos, []);
  });

  test('операция бросает: исключение пробрасывается как есть, замок освобождён', async () => {
    const failure = new Error('отказ операции');
    await assert.rejects(
      () => runWithConfigurationOperationLockOrThrow(() => Promise.reject(failure)),
      (error: Error) => error === failure
    );
    assert.strictEqual(isConfigurationOperationRunning(), false);
  });
});

suite('CfFileTarget: resolveApplyTargetFromNode', () => {
  const node = (model: ConstructorParameters<typeof MetadataNode>[0]): MetadataNode =>
    new MetadataNode(model, vscode.TreeItemCollapsibleState.None);
  const cfXml = path.join('C:', 'проект', 'src', 'cf', 'Configuration.xml');
  const cfeXml = path.join('C:', 'проект', 'src', 'cfe', 'Расш', 'Configuration.xml');

  test('корень основной конфигурации: kind=cf, имя «Основная конфигурация», rootPath — каталог Configuration.xml узла, без extensionName', () => {
    const target = resolveApplyTargetFromNode(node({ label: 'Основная', nodeKind: 'configuration', xmlPath: cfXml }));
    assert.ok(target);
    assert.strictEqual(target.kind, 'cf');
    assert.strictEqual(target.name, 'Основная конфигурация');
    assert.strictEqual(target.rootPath, path.dirname(cfXml));
    assert.strictEqual(target.extensionName, undefined);
  });

  test('корень расширения: kind=cfe, name и extensionName — имя расширения, rootPath — каталог из xmlPath узла (а не из раскладки)', () => {
    const target = resolveApplyTargetFromNode(node({ label: 'Расш', nodeKind: 'extension', xmlPath: cfeXml }));
    assert.ok(target);
    assert.strictEqual(target.kind, 'cfe');
    assert.strictEqual(target.name, 'Расш');
    assert.strictEqual(target.extensionName, 'Расш');
    assert.strictEqual(target.rootPath, path.dirname(cfeXml));
  });

  test('нетипичная раскладка: rootPath следует за xmlPath узла, а не за src/cf', () => {
    const odd = path.join('D:', 'где-то', 'иначе', 'Configuration.xml');
    const target = resolveApplyTargetFromNode(node({ label: 'Основная', nodeKind: 'configuration', xmlPath: odd }));
    assert.strictEqual(target?.rootPath, path.dirname(odd));
  });

  test('не корень (объект, группа), корень без xmlPath, расширение без имени → undefined', () => {
    assert.strictEqual(resolveApplyTargetFromNode(node({ label: 'Товары', nodeKind: 'Catalog', xmlPath: cfXml })), undefined);
    assert.strictEqual(resolveApplyTargetFromNode(node({ label: 'Группа', nodeKind: 'group-type' })), undefined);
    assert.strictEqual(resolveApplyTargetFromNode(node({ label: 'Основная', nodeKind: 'configuration' })), undefined);
    assert.strictEqual(resolveApplyTargetFromNode(node({ label: '', nodeKind: 'extension', xmlPath: cfeXml })), undefined);
  });
});
