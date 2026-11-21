/**
 * Загрузка без обновления БД: настройка `v8vscedit.configuration.updateDatabaseAfterLoad`, новые команды
 * (`package.json` + `CommandRegistry`) и пункты контекстного меню корня (`getNodeActions`).
 *
 * Настройка управляет только НЕЯВНЫМИ загрузками («Обновить изменённые конфигурации», шаг загрузки в
 * цепочках хранилища); явные команды узла от неё не зависят. По умолчанию `true` — поведение не меняется
 * без явного выбора пользователя (решение оркестратора: boolean, «спрашивать» не делаем).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { CommandServices } from '../../ui/commands/_shared';
import { registerCommands } from '../../ui/commands/CommandRegistry';
import { readUpdateDatabaseAfterLoad } from '../../ui/commands/ext/databaseSettings';
import { skipWithoutCorpus } from './support/corpus';
import { createUniversalPanelFixture, type UniversalPanelFixture } from './support/universalPanelHarness';

const ROOT = path.resolve(__dirname, '../../..');
const SETTING_KEY = 'v8vscedit.configuration.updateDatabaseAfterLoad';
const LOAD_ID = 'v8vscedit.loadConfigurationChangesInDb';
const UPDATE_DB_ID = 'v8vscedit.updateDatabaseConfiguration';
const LAG_ACTIONS_ID = 'v8vscedit.databaseLag.showActions';
const UPDATE_IN_DB_ID = 'v8vscedit.updateConfigurationInDb';

interface Manifest {
  contributes: {
    commands: { command: string; title?: string; enablement?: string }[];
    configuration: { properties?: Record<string, { type?: string; default?: unknown; description?: string }> } | { properties?: Record<string, { type?: string; default?: unknown; description?: string }> }[];
  };
}

const manifest = (): Manifest => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')) as Manifest;

function allProperties(): Record<string, { type?: string; default?: unknown; description?: string }> {
  const configuration = manifest().contributes.configuration;
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  return Object.assign({}, ...sections.map((section) => section.properties ?? {})) as Record<string, { type?: string; default?: unknown; description?: string }>;
}

suite('Настройка updateDatabaseAfterLoad: манифест', () => {
  test('объявлена: boolean, default true, описание на русском с упоминанием «Обновить конфигурацию БД»', () => {
    const property = allProperties()[SETTING_KEY];
    assert.ok(property, `${SETTING_KEY} не объявлена в contributes.configuration`);
    assert.strictEqual(property.type, 'boolean');
    assert.strictEqual(property.default, true);
    assert.ok(/[А-Яа-я]/.test(property.description ?? ''), 'описание на русском');
    assert.ok((property.description ?? '').includes('Обновить конфигурацию БД'), property.description);
    assert.ok((property.description ?? '').includes('Обновить изменённые конфигурации'), property.description);
  });
});

suite('readUpdateDatabaseAfterLoad', () => {
  const configuration = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('v8vscedit.configuration');
  const set = (value: unknown): Thenable<void> => configuration().update('updateDatabaseAfterLoad', value, vscode.ConfigurationTarget.Global);
  teardown(async () => { await set(undefined); });

  test('не задана → true (обратная совместимость)', async () => {
    await set(undefined);
    assert.strictEqual(readUpdateDatabaseAfterLoad(), true);
  });

  test('true → true', async () => {
    await set(true);
    assert.strictEqual(readUpdateDatabaseAfterLoad(), true);
  });

  test('false → false', async () => {
    await set(false);
    assert.strictEqual(readUpdateDatabaseAfterLoad(), false);
  });

  test('значение не boolean в settings.json (строка «false») → умолчание true: только явное false отключает обновление', async () => {
    await set('false');
    assert.strictEqual(readUpdateDatabaseAfterLoad(), true);
  });
});

suite('Новые команды: package.json и CommandRegistry', () => {
  const NEW_IDS = [LOAD_ID, UPDATE_DB_ID, LAG_ACTIONS_ID];

  test('все три команды объявлены в contributes.commands с непустым title и enablement по isUpdatingConfigurations', () => {
    const declared = manifest().contributes.commands;
    for (const id of NEW_IDS) {
      const entry = declared.find((item) => item.command === id);
      assert.ok(entry, `${id} не объявлена`);
      assert.ok(entry.title && entry.title.trim().length > 0, `${id}: title`);
      assert.strictEqual(entry.enablement, '!v8vscedit.isUpdatingConfigurations', `${id}: enablement`);
    }
  });

  test('заголовки команд: «Загрузить в базу без обновления БД», «Обновить конфигурацию БД», «1С: конфигурация БД не обновлена»', () => {
    const titleOf = (id: string): string => manifest().contributes.commands.find((item) => item.command === id)?.title ?? '';
    assert.ok(titleOf(LOAD_ID).includes('Загрузить в базу без обновления БД'), titleOf(LOAD_ID));
    assert.ok(titleOf(UPDATE_DB_ID).includes('Обновить конфигурацию БД'), titleOf(UPDATE_DB_ID));
    assert.ok(titleOf(LAG_ACTIONS_ID).includes('конфигурация БД не обновлена'), titleOf(LAG_ACTIONS_ID));
  });

  test('enablement updateChangedConfigurations учитывает отставание БД при включённой настройке', () => {
    const entry = manifest().contributes.commands.find((item) => item.command === 'v8vscedit.updateChangedConfigurations');
    assert.ok(entry?.enablement, 'enablement задан');
    assert.ok(entry.enablement.includes('v8vscedit.hasChangedConfigurations'), entry.enablement);
    assert.ok(entry.enablement.includes('v8vscedit.databaseConfigurationBehind'), entry.enablement);
    assert.ok(entry.enablement.includes(`config.${SETTING_KEY}`), entry.enablement);
    assert.ok(entry.enablement.includes('!v8vscedit.isUpdatingConfigurations'), entry.enablement);
  });

  test('registerCommands реально регистрирует все три команды (подключены в общую проводку, а не только объявлены)', async () => {
    const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
    registerCommands(context, {} as unknown as CommandServices);
    try {
      const registered = await vscode.commands.getCommands(true);
      for (const id of NEW_IDS) {
        assert.ok(registered.includes(id), `${id} не зарегистрирована в CommandRegistry`);
      }
    } finally {
      for (const disposable of context.subscriptions) {
        disposable.dispose();
      }
    }
  });
});

suite('getNodeActions: пункты загрузки без обновления БД и обновления конфигурации БД', () => {
  let fixture: UniversalPanelFixture | undefined;

  suiteSetup(function () {
    skipWithoutCorpus(this);
    this.timeout(60_000);
    fixture = createUniversalPanelFixture();
  });
  suiteTeardown(() => { fixture?.dispose(); });

  const commandsOf = (node: { readonly actions: readonly { readonly command: string }[] }): string[] => node.actions.map((action) => action.command);
  const need = (): UniversalPanelFixture => {
    assert.ok(fixture, 'фикстура панели не создана');
    return fixture;
  };

  function assertBoth(node: { readonly actions: readonly { readonly command: string; readonly label: string; readonly icon?: unknown }[] }): void {
    const commands = commandsOf(node);
    const load = node.actions.find((action) => action.command === LOAD_ID);
    const update = node.actions.find((action) => action.command === UPDATE_DB_ID);
    assert.ok(load && update, commands.join(', '));
    assert.strictEqual(load.label, 'Загрузить в базу без обновления БД');
    assert.strictEqual(update.label, 'Обновить конфигурацию БД');
    assert.ok(load.icon && update.icon, 'у обоих пунктов есть иконка');
    // Пункты идут сразу после «Обновить в базе».
    const base = commands.indexOf(UPDATE_IN_DB_ID);
    assert.ok(base >= 0, 'пункт «Обновить в базе» присутствует');
    assert.deepStrictEqual(commands.slice(base + 1, base + 3), [LOAD_ID, UPDATE_DB_ID]);
  }

  test('корень основной конфигурации (configuration-hasXml): оба пункта сразу после «Обновить в базе»', () => {
    const root = need().rootNodes.find((node) => node.kind === 'configuration');
    assert.ok(root);
    assertBoth(root);
  });

  test('корень расширения (extension-hasXml): оба пункта', async () => {
    const container = need().rootNodes.find((node) => node.kind === 'extensions-root');
    assert.ok(container);
    const extension = (await need().loadChildren(container.id)).find((node) => node.kind === 'extension');
    assert.ok(extension);
    assertBoth(extension);
  });

  test('обычный объект метаданных (не корень): ни одного из пунктов', async () => {
    const root = need().rootNodes.find((node) => node.kind === 'configuration');
    assert.ok(root);
    const group = (await need().loadChildren(root.id)).find((node) => node.label === 'Справочники');
    assert.ok(group);
    const catalog = (await need().loadChildren(group.id))[0];
    assert.strictEqual(catalog.kind, 'Catalog');
    const commands = commandsOf(catalog);
    assert.ok(!commands.includes(LOAD_ID) && !commands.includes(UPDATE_DB_ID), commands.join(', '));
  });
});
