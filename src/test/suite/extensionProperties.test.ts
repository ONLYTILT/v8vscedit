/**
 * Разбор ответа `properties get --all-extensions` и признак неприменённой заглушки
 * (domain/agent/ExtensionProperties.ts). Форма ответа — ФАКТ Э29, П1:
 * `success.body = [{type:'extension-properties', body:{name, version, active, purpose, 'safe-mode', …, 'hash-sum'}}]`,
 * пустая база — `[]`; булевы поля — JSON boolean. Заглушка — ровно нулевой хеш `AAAAAAAAAAAAAAAAAAAAAAAAAAA=` (П8).
 */
import * as assert from 'assert';
import type { AgentMessage } from '../../domain/agent';
import {
  ExtensionPropertiesFormatError,
  isUnappliedExtensionStub,
  parseExtensionProperties,
} from '../../domain/agent';

const ZERO = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function element(name: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'extension-properties',
    body: {
      name,
      version: '1.0',
      active: true,
      purpose: 'customization',
      'safe-mode': false,
      'security-profile-name': 'Профиль',
      'unsafe-action-protection': true,
      'used-in-distributed-infobase': false,
      scope: 'infobase',
      'hash-sum': 'qwe+/rty=',
      ...overrides,
    },
  };
}

const success = (body: unknown): AgentMessage => ({ type: 'success', body });

suite('parseExtensionProperties', () => {
  test('пустая база: body [] — пустой список', () => {
    assert.deepStrictEqual(parseExtensionProperties([success([])]), []);
  });

  test('одна запись: все поля переносятся в camelCase', () => {
    assert.deepStrictEqual(parseExtensionProperties([success([element('Расш')])]), [{
      name: 'Расш',
      hashSum: 'qwe+/rty=',
      version: '1.0',
      active: true,
      purpose: 'customization',
      safeMode: false,
      securityProfileName: 'Профиль',
      unsafeActionProtection: true,
      usedInDistributedInfobase: false,
      scope: 'infobase',
    }]);
  });

  test('ОДНО расширение: элемент верхнего уровня без success (ФАКТ Э30–Э31) — список из одного', () => {
    const infos = parseExtensionProperties([element('Единственное') as AgentMessage]);
    assert.deepStrictEqual(infos.map((info) => info.name), ['Единственное']);
    assert.strictEqual(infos[0].hashSum, 'qwe+/rty=');
  });

  test('ОДНО расширение без success, но с log перед ним — log не мешает', () => {
    const infos = parseExtensionProperties([{ type: 'log', message: 'x' }, element('X') as AgentMessage]);
    assert.deepStrictEqual(infos.map((info) => info.name), ['X']);
  });

  test('несколько записей — порядок ответа сохраняется (сортирует вызывающий)', () => {
    const infos = parseExtensionProperties([success([element('B'), element('A'), element('C')])]);
    assert.deepStrictEqual(infos.map((info) => info.name), ['B', 'A', 'C']);
  });

  test('берётся ПОСЛЕДНЕЕ сообщение с массивом body: промежуточное игнорируется', () => {
    const infos = parseExtensionProperties([
      { type: 'extension-info', body: [element('Старое')] },
      success([element('Новое')]),
    ]);
    assert.deepStrictEqual(infos.map((info) => info.name), ['Новое']);
  });

  test('body в промежуточном сообщении, а итоговый success без body — берётся промежуточное', () => {
    const infos = parseExtensionProperties([{ type: 'extension-info', body: [element('X')] }, { type: 'success' }]);
    assert.deepStrictEqual(infos.map((info) => info.name), ['X']);
  });

  test('error-сообщения игнорируются при поиске body', () => {
    const infos = parseExtensionProperties([
      success([element('X')]),
      { type: 'error', body: [element('Мусор')] },
    ]);
    assert.deepStrictEqual(infos.map((info) => info.name), ['X']);
  });

  const booleans: [unknown, boolean | undefined][] = [
    [true, true], [false, false], ['yes', true], ['no', false], ['maybe', undefined], [1, undefined], [null, undefined],
  ];
  for (const [raw, expected] of booleans) {
    test(`булево поле active = ${JSON.stringify(raw)} → ${String(expected)}`, () => {
      const [info] = parseExtensionProperties([success([element('X', { active: raw })])]);
      assert.strictEqual(info.active, expected);
    });
  }

  test('необязательные поля отсутствуют → undefined, запись не отвергается', () => {
    const [info] = parseExtensionProperties([success([{ type: 'extension-properties', body: { name: 'X', 'hash-sum': 'h' } }])]);
    assert.strictEqual(info.name, 'X');
    assert.strictEqual(info.hashSum, 'h');
    assert.strictEqual(info.version, undefined);
    assert.strictEqual(info.safeMode, undefined);
    assert.strictEqual(info.scope, undefined);
  });

  const failures: [string, AgentMessage[]][] = [
    ['нет сообщений вообще', []],
    ['нет ни одного сообщения с массивом body', [{ type: 'success' }, { type: 'log', message: 'x' }]],
    ['body — не массив', [success({ name: 'X' })]],
    ['элемент чужого типа', [success([{ type: 'other', body: { name: 'X', 'hash-sum': 'h' } }])]],
    ['нет name', [success([{ type: 'extension-properties', body: { 'hash-sum': 'h' } }])]],
    ['пустое name', [success([element('')])]],
    ['нет hash-sum', [success([{ type: 'extension-properties', body: { name: 'X' } }])]],
    ['элемент не объект', [success(['строка'])]],
    ['body элемента не объект', [success([{ type: 'extension-properties', body: 'x' }])]],
  ];
  for (const [title, messages] of failures) {
    test(`fail closed: ${title} → ExtensionPropertiesFormatError`, () => {
      assert.throws(() => parseExtensionProperties(messages), ExtensionPropertiesFormatError);
    });
  }
});

suite('isUnappliedExtensionStub', () => {
  const info = (hashSum: string) => ({ name: 'X', hashSum });

  test('нулевой хеш AAAAAAAAAAAAAAAAAAAAAAAAAAA= — заглушка', () => {
    assert.strictEqual(isUnappliedExtensionStub(info(ZERO)), true);
  });

  const notStubs: [string, string][] = [
    ['пустой хеш', ''],
    ['настоящий хеш', 'qwe+/rty='],
    ['«содержит A» — не признак', 'AAAAAAAAAAAAAAAAAAAAAAAAAAB='],
    ['смешанный', 'AAAAxAAAAAAAAAAAAAAAAAAAAAA='],
  ];
  for (const [title, hash] of notStubs) {
    test(`не заглушка: ${title}`, () => {
      assert.strictEqual(isUnappliedExtensionStub(info(hash)), false);
    });
  }

  test('version не признак: пустая версия у применённого расширения заглушкой не делает', () => {
    assert.strictEqual(isUnappliedExtensionStub({ name: 'X', hashSum: 'qwe+/rty=', version: '' }), false);
  });
});
