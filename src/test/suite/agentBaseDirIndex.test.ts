import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseAgentBaseDirIndex, resolveAgentUserDir } from '../../domain/agent/AgentBaseDirIndex';

const SAMPLE = path.resolve(__dirname, '..', '..', '..', 'tmp', 'agentbasedir.json');

suite('AgentBaseDirIndex: разбор agentbasedir.json', () => {
  test('образец агента (CRLF, отступы) разбирается в список пользователей', function () {
    // tmp/ не в git: на чистом клоне образца нет — тогда проверяет синтетический тест ниже.
    if (!fs.existsSync(SAMPLE)) { this.skip(); }
    const index = parseAgentBaseDirIndex(fs.readFileSync(SAMPLE, 'utf-8'));
    assert.deepStrictEqual(index, [{ name: 'КытмановА', dir: '0' }]);
  });

  test('минимальный корректный файл', () => {
    const text = '{\r\n"usersInfo": [\r\n{\r\n"name": "КытмановА",\r\n"dir": "0"\r\n}\r\n]\r\n}';
    assert.deepStrictEqual(parseAgentBaseDirIndex(text), [{ name: 'КытмановА', dir: '0' }]);
  });

  test('несколько пользователей сохраняют порядок; лишние поля игнорируются', () => {
    const text = JSON.stringify({ usersInfo: [{ name: 'A', dir: '0', x: 1 }, { name: 'B', dir: '1' }], other: true });
    assert.deepStrictEqual(parseAgentBaseDirIndex(text), [{ name: 'A', dir: '0' }, { name: 'B', dir: '1' }]);
  });

  test('пустой usersInfo → пустой список', () => {
    assert.deepStrictEqual(parseAgentBaseDirIndex('{"usersInfo":[]}'), []);
  });

  test('UTF-8 BOM в начале снимается', () => {
    assert.deepStrictEqual(parseAgentBaseDirIndex('﻿{"usersInfo":[{"name":"A","dir":"3"}]}'), [{ name: 'A', dir: '3' }]);
  });

  test('битый JSON → ошибка с упоминанием agentbasedir.json', () => {
    assert.throws(() => parseAgentBaseDirIndex('{"usersInfo": ['), /agentbasedir\.json/);
  });

  test('пустой текст и только BOM → ошибка', () => {
    assert.throws(() => parseAgentBaseDirIndex(''), /agentbasedir\.json/);
    assert.throws(() => parseAgentBaseDirIndex('﻿  '), /agentbasedir\.json/);
  });

  test('корень не объект / нет usersInfo / usersInfo не массив → ошибка с упоминанием usersInfo', () => {
    for (const text of ['[]', 'null', '42', '{}', '{"usersInfo":{}}', '{"usersInfo":"x"}']) {
      assert.throws(() => parseAgentBaseDirIndex(text), /usersInfo/, text);
    }
  });

  test('запись не объект или без строкового name пропускается: остальные пользователи не страдают', () => {
    for (const entry of ['null', '"x"', '{"dir":"0"}', '{"name":5,"dir":"0"}', '{"name":"","dir":"0"}', '{"name":"  ","dir":"0"}']) {
      assert.deepStrictEqual(
        parseAgentBaseDirIndex(`{"usersInfo":[${entry},{"name":"B","dir":"1"}]}`),
        [{ name: 'B', dir: '1' }],
        entry
      );
    }
  });

  test('небезопасный dir не роняет разбор: запись помечается, ошибка всплывает только у её владельца', () => {
    const bad = ['', '   ', ' 0', '.', '..', 'a/b', 'a\\b', 'a\b', '../x', 'C:', '/abs', 'a\u0000b', 'a\tb', 'a*b'];
    for (const dir of bad) {
      const text = JSON.stringify({ usersInfo: [{ name: 'A', dir }, { name: 'B', dir: '1' }] });
      const index = parseAgentBaseDirIndex(text);
      assert.strictEqual(index.length, 2, JSON.stringify(dir));
      assert.ok('error' in index[0], JSON.stringify(dir));
      assert.strictEqual(resolveAgentUserDir(index, 'B'), '1', JSON.stringify(dir));
      assert.throws(
        () => resolveAgentUserDir(index, 'a'),
        (error: Error) => error.message.includes('agentbasedir.json') && error.message.includes('dir') && error.message.includes('"A"'),
        JSON.stringify(dir)
      );
    }
  });

  test('dir не строка (число, отсутствует) → запись помечена, ошибка у владельца называет dir', () => {
    for (const text of ['{"usersInfo":[{"name":"A","dir":0}]}', '{"usersInfo":[{"name":"A"}]}']) {
      const index = parseAgentBaseDirIndex(text);
      assert.throws(() => resolveAgentUserDir(index, 'A'), /agentbasedir\.json.*dir|dir.*agentbasedir\.json/, text);
      assert.strictEqual(resolveAgentUserDir(index, 'other'), undefined, text);
    }
  });

  test('безопасный dir с кириллицей, точками и дефисом принимается', () => {
    const text = JSON.stringify({ usersInfo: [{ name: 'A', dir: 'Пользователь.1-x_y' }] });
    assert.deepStrictEqual(parseAgentBaseDirIndex(text), [{ name: 'A', dir: 'Пользователь.1-x_y' }]);
  });
});

suite('AgentBaseDirIndex: resolveAgentUserDir', () => {
  const index = [
    { name: 'КытмановА', dir: '0' },
    { name: 'Petrov', dir: '1' },
    { name: 'petrov', dir: '2' },
  ];

  test('точное совпадение', () => {
    assert.strictEqual(resolveAgentUserDir(index, 'КытмановА'), '0');
  });

  test('регистр кириллицы и латиницы не важен', () => {
    assert.strictEqual(resolveAgentUserDir(index, 'кытмановА'), '0');
    assert.strictEqual(resolveAgentUserDir(index, 'КЫТМАНОВа'), '0');
    assert.strictEqual(resolveAgentUserDir(index, 'PETROV'), '1');
  });

  test('при совпадении имён без учёта регистра выигрывает первая запись', () => {
    assert.strictEqual(resolveAgentUserDir(index, 'petrov'), '1');
  });

  test('первая совпавшая запись невалидна → ошибка, даже если ниже есть валидный дубль', () => {
    assert.throws(
      () => resolveAgentUserDir([{ name: 'X', error: 'плохой' }, { name: 'x', dir: '5' }], 'X'),
      /agentbasedir\.json/
    );
  });

  test('пробелы вокруг логина не мешают; логин из одних пробелов → undefined', () => {
    assert.strictEqual(resolveAgentUserDir(index, '  Petrov '), '1');
    assert.strictEqual(resolveAgentUserDir(index, '   '), undefined);
    assert.strictEqual(resolveAgentUserDir([{ name: ' Иванов  ', dir: '4' }], 'иванов'), '4');
  });

  test('отсутствующий и пустой пользователь → undefined', () => {
    assert.strictEqual(resolveAgentUserDir(index, 'ghost'), undefined);
    assert.strictEqual(resolveAgentUserDir(index, ''), undefined);
    assert.strictEqual(resolveAgentUserDir([], 'КытмановА'), undefined);
  });
});
