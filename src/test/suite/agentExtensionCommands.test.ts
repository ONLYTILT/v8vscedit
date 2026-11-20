/**
 * Построение строк команд агента для CF/CFE-файлов и списка расширений (domain/agent/AgentExtensionCommands.ts).
 * Вектор команды обязан быть под ТОЧНЫМ регресс-тестом: агент молча принимает неизвестные ключи, а
 * `properties get --extension=<имя>` не падает, а ЗАВИСАЕТ (ФАКТ Э29) — сигнатура не даёт его построить.
 */
import * as assert from 'assert';
import * as agentDomain from '../../domain/agent';
import {
  buildDumpCfgCommand,
  buildExtensionsPropertiesGetAllCommand,
  buildLoadCfgCommand,
} from '../../domain/agent';

suite('AgentExtensionCommands: строки команд dump-cfg / load-cfg / properties get', () => {
  const FILE = 'exchange/cffile-p-1/payload.cfe';

  const named: [string, string, string][] = [
    ['латиница', 'EVOLC', '--extension=EVOLC'],
    ['кириллица без пробелов', 'Расш', '--extension=Расш'],
    ['пробел и кириллица — в кавычках', 'Моё расш', '--extension="Моё расш"'],
    ['кавычка внутри имени экранируется', 'A"B', '--extension="A\\"B"'],
  ];
  for (const [title, name, tail] of named) {
    test(`dump-cfg: имя расширения, ${title}`, () => {
      assert.strictEqual(buildDumpCfgCommand(FILE, name), `config dump-cfg --file=${FILE} ${tail}`);
    });
    test(`load-cfg: имя расширения, ${title}`, () => {
      assert.strictEqual(buildLoadCfgCommand(FILE, name), `config load-cfg --file=${FILE} ${tail}`);
    });
  }

  const mainConfig: [string, string | undefined][] = [['имя не задано', undefined], ['пустое', ''], ['пробельное', '   ']];
  for (const [title, name] of mainConfig) {
    test(`dump-cfg/load-cfg: ${title} — основная конфигурация, без --extension`, () => {
      assert.strictEqual(buildDumpCfgCommand('exchange/x/payload.cf', name), 'config dump-cfg --file=exchange/x/payload.cf');
      assert.strictEqual(buildLoadCfgCommand('exchange/x/payload.cf', name), 'config load-cfg --file=exchange/x/payload.cf');
    });
  }

  test('properties get: точная строка с --all-extensions', () => {
    assert.strictEqual(buildExtensionsPropertiesGetAllCommand(), 'config extensions properties get --all-extensions');
  });

  test('встречное утверждение: ни одна функция модуля не строит properties get --extension', () => {
    const builders = Object.entries(agentDomain).filter(([name, value]) => /^build.*Command$/.test(name) && typeof value === 'function');
    assert.ok(builders.length > 0);
    const produced: string[] = [];
    for (const [, build] of builders) {
      // Разные формы аргументов: у любого строителя имя расширения — необязательная строка или опция.
      for (const args of [[], ['x'], ['x', 'Расш'], ['Расш'], [{ extensionName: 'Расш' }], ['x', { extensionName: 'Расш' }]]) {
        try {
          produced.push((build as (...a: unknown[]) => string)(...args));
        } catch {
          // неподходящая сигнатура — нормальный исход перебора
        }
      }
    }
    assert.ok(produced.some((line) => line.startsWith('config extensions properties get')));
    assert.ok(
      !produced.some((line) => line.includes('properties get') && /--extension\b(?!s)/.test(line)),
      produced.filter((line) => line.includes('properties get')).join('\n')
    );
  });
});
