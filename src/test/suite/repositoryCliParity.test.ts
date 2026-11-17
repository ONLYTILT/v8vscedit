import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRepositoryCliRequest,
  parseRepositoryOperation,
  type RepositoryCliCommand,
} from '../../cli/commands/repositoryCommands';
import type { CliArgs } from '../../cli/core/types';
import {
  buildRepositoryDesignerRequest,
  type RepositoryOperation,
} from '../../infra/repository/RepositoryDesignerArgs';

/**
 * Паритет CLI `repository-*` и расширения: оба потребителя строят вектор ОДНИМ
 * `buildRepositoryDesignerRequest`. Прежде их было два (UI: `buildCommandDesignerArgs`,
 * CLI: ручная сборка в `repositoryCommands.ts`) с разным порядком аргументов — а платформа
 * молча игнорирует неизвестные ключи, поэтому расхождение не поймал бы ни один запуск.
 *
 * Контракт, который ожидают тесты от `cli/commands/repositoryCommands.ts`:
 *  - `parseRepositoryOperation(command, args)` разбирает аргументы CLI в `RepositoryOperation`
 *    (`-ObjectsFile <путь>` читается в `objectsXml` БАЙТАМИ без перекодировки; `-File` у
 *    `repository-dump`/`repository-report` обязателен, но в вектор не попадает: выходной
 *    файл объявляет построитель, перенос на `-File` — дело CLI после `exitCode === 0`);
 *  - `buildRepositoryCliRequest(command, args)` = подключение из `-InfoBase*`/`-UserName`/
 *    `-Password`, хранилище из `-RepoPath`/`-RepoUser`/`-RepoPassword`, `-Extension`.
 * Сравнивается итоговый ВЕКТОР, а не форма объекта операции: отсутствие поля и `undefined`
 * для построителя неразличимы, а ассерт на форму закрепил бы лишнее.
 */

const CONNECTION_ARGS: CliArgs = {
  InfoBaseServer: 'srv',
  InfoBaseRef: 'db',
  UserName: 'Админ',
  Password: 'dbpw',
  RepoPath: '\\\\repo\\storage',
  RepoUser: 'dev',
  RepoPassword: 'rp',
};

const BINDING = { repoPath: '\\\\repo\\storage', repoUser: 'dev', repoPassword: 'rp' };
const CONNECTION = { infoBaseServer: 'srv', infoBaseRef: 'db', userName: 'Админ', password: 'dbpw' };

interface ParityCase {
  readonly command: RepositoryCliCommand;
  readonly title: string;
  readonly args: CliArgs;
  /** Ожидаемая операция; `objectsXml` — байты файла, если у случая есть ObjectsFile. */
  readonly op: (objectsXml: Uint8Array | undefined) => RepositoryOperation;
  readonly withObjectsFile?: boolean;
}

const COMMENT = 'Исправление "ошибки" №1';

const PARITY_CASES: readonly ParityCase[] = [
  { command: 'repository-create', title: 'минимум', args: {}, op: () => ({ kind: 'create' }) },
  {
    command: 'repository-create',
    title: 'все флаги',
    args: {
      AllowConfigurationChanges: true,
      ChangesAllowedRule: 'ObjectsAllowed',
      ChangesNotRecommendedRule: 'ObjectNotRecommended',
      NoBind: true,
    },
    op: () => ({
      kind: 'create',
      allowConfigurationChanges: true,
      changesAllowedRule: 'ObjectsAllowed',
      changesNotRecommendedRule: 'ObjectNotRecommended',
      noBind: true,
    }),
  },
  { command: 'repository-bind', title: 'минимум', args: {}, op: () => ({ kind: 'bind' }) },
  {
    command: 'repository-bind',
    title: 'оба флага',
    args: { ForceBindAlreadyBindedUser: true, ForceReplaceCfg: true },
    op: () => ({ kind: 'bind', forceBindAlreadyBindedUser: true, forceReplaceCfg: true }),
  },
  { command: 'repository-unbind', title: 'минимум', args: {}, op: () => ({ kind: 'unbind' }) },
  { command: 'repository-unbind', title: 'force', args: { Force: true }, op: () => ({ kind: 'unbind', force: true }) },
  { command: 'repository-lock', title: 'без ObjectsFile', args: {}, op: () => ({ kind: 'lock' }) },
  {
    command: 'repository-lock',
    title: 'ObjectsFile и Revised',
    args: { Revised: true },
    withObjectsFile: true,
    op: (objectsXml) => ({ kind: 'lock', objectsXml, revised: true }),
  },
  { command: 'repository-unlock', title: 'без ObjectsFile', args: {}, op: () => ({ kind: 'unlock' }) },
  {
    command: 'repository-unlock',
    title: 'ObjectsFile и Force',
    args: { Force: true },
    withObjectsFile: true,
    op: (objectsXml) => ({ kind: 'unlock', objectsXml, force: true }),
  },
  { command: 'repository-commit', title: 'без параметров', args: {}, op: () => ({ kind: 'commit' }) },
  {
    command: 'repository-commit',
    title: 'все параметры',
    args: { Comment: COMMENT, KeepLocked: true, Force: true },
    withObjectsFile: true,
    op: (objectsXml) => ({ kind: 'commit', objectsXml, comment: COMMENT, keepLocked: true, force: true }),
  },
  { command: 'repository-update', title: 'без параметров', args: {}, op: () => ({ kind: 'update' }) },
  {
    command: 'repository-update',
    title: 'все параметры',
    args: { Version: '7', Force: true },
    withObjectsFile: true,
    op: (objectsXml) => ({ kind: 'update', objectsXml, version: '7', force: true }),
  },
  {
    command: 'repository-add-user',
    title: 'обязательные',
    args: { User: 'Иванов', Pwd: 'upw', Rights: 'LockObjects' },
    op: () => ({ kind: 'addUser', user: 'Иванов', password: 'upw', rights: 'LockObjects' }),
  },
  {
    command: 'repository-add-user',
    title: 'с RestoreDeletedUser',
    args: { User: 'Иванов', Pwd: 'upw', Rights: 'LockObjects', RestoreDeletedUser: true },
    op: () => ({ kind: 'addUser', user: 'Иванов', password: 'upw', rights: 'LockObjects', restoreDeletedUser: true }),
  },
  {
    command: 'repository-copy-users',
    title: 'обязательные',
    args: { Path: 'C:\\src repo', User: 'Админ', Pwd: 'upw' },
    op: () => ({ kind: 'copyUsers', path: 'C:\\src repo', user: 'Админ', password: 'upw' }),
  },
  {
    command: 'repository-copy-users',
    title: 'с RestoreDeletedUser',
    args: { Path: 'C:\\src repo', User: 'Админ', Pwd: 'upw', RestoreDeletedUser: true },
    op: () => ({ kind: 'copyUsers', path: 'C:\\src repo', user: 'Админ', password: 'upw', restoreDeletedUser: true }),
  },
  {
    command: 'repository-dump',
    title: 'без версии: -File в операцию не попадает',
    args: { File: 'C:\\out\\версия.cf' },
    op: () => ({ kind: 'dump' }),
  },
  {
    command: 'repository-dump',
    title: 'с версией',
    args: { File: 'C:\\out\\версия.cf', Version: '15' },
    op: () => ({ kind: 'dump', version: '15' }),
  },
  {
    command: 'repository-report',
    title: 'минимум',
    args: { File: 'C:\\out\\report.txt' },
    op: () => ({ kind: 'report' }),
  },
  {
    command: 'repository-report',
    title: 'все параметры',
    args: {
      File: 'C:\\out\\report.txt',
      NBegin: '1',
      NEnd: '9',
      DateBegin: '2024-01-01',
      DateEnd: '2024-12-31',
      ConfigurationVersion: '1.2.3',
      ReportFormat: 'txt',
      GroupByObject: true,
      GroupByComment: true,
      DoNotIncludeVersionsWithLabels: true,
      IncludeOnlyVersionsWithLabels: true,
      IncludeCommentLinesWithDoubleSlash: true,
    },
    op: () => ({
      kind: 'report',
      nBegin: '1',
      nEnd: '9',
      dateBegin: '2024-01-01',
      dateEnd: '2024-12-31',
      configurationVersion: '1.2.3',
      reportFormat: 'txt',
      groupByObject: true,
      groupByComment: true,
      doNotIncludeVersionsWithLabels: true,
      includeOnlyVersionsWithLabels: true,
      includeCommentLinesWithDoubleSlash: true,
    }),
  },
  {
    command: 'repository-set-label',
    title: 'только имя',
    args: { LabelName: 'Релиз 1' },
    op: () => ({ kind: 'setLabel', name: 'Релиз 1' }),
  },
  {
    command: 'repository-set-label',
    title: 'версия и комментарий',
    args: { LabelName: 'Релиз 1', Version: '3', Comment: COMMENT },
    op: () => ({ kind: 'setLabel', name: 'Релиз 1', version: '3', comment: COMMENT }),
  },
];

suite('CLI repository-* — паритет с единым построителем вектора', () => {
  let tempDir: string;
  let v8Path: string;
  let objectsFile: string;
  const OBJECTS_XML = '<Objects version="1.0">\n  <Object fullName="Справочник.Товары"/>\n</Objects>\n';

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-clirepo-'));
    v8Path = path.join(tempDir, process.platform === 'win32' ? '1cv8.exe' : '1cv8');
    fs.writeFileSync(v8Path, '', 'utf-8');
    fs.chmodSync(v8Path, 0o755);
    objectsFile = path.join(tempDir, 'objects.xml');
    fs.writeFileSync(objectsFile, OBJECTS_XML, 'utf-8');
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function argsFor(item: ParityCase, extra: CliArgs = {}): CliArgs {
    return {
      ...CONNECTION_ARGS,
      V8Path: v8Path,
      ...item.args,
      ...(item.withObjectsFile ? { ObjectsFile: objectsFile } : {}),
      ...extra,
    };
  }

  for (const item of PARITY_CASES) {
    for (const extension of [undefined, 'EVOLC']) {
      const suffix = extension ? ' с -Extension' : '';
      test(`${item.command}: ${item.title}${suffix}`, () => {
        const args = argsFor(item, extension ? { Extension: extension } : {});
        const objectsXml = item.withObjectsFile ? fs.readFileSync(objectsFile) : undefined;
        const expected = buildRepositoryDesignerRequest(CONNECTION, BINDING, item.op(objectsXml), extension);

        const viaOperation = buildRepositoryDesignerRequest(
          CONNECTION,
          BINDING,
          parseRepositoryOperation(item.command, args),
          extension
        );
        const viaCli = buildRepositoryCliRequest(item.command, args);

        assert.deepStrictEqual(viaOperation.args, expected.args);
        assert.deepStrictEqual(viaOperation.secrets, expected.secrets);
        assert.deepStrictEqual(viaCli.args, expected.args);
        assert.deepStrictEqual(viaCli.secrets, expected.secrets);
      });
    }
  }

  test('регресс: lock с ObjectsFile — литеральный вектор, содержимое файла уходит как inputFile', () => {
    const request = buildRepositoryCliRequest('repository-lock', {
      ...CONNECTION_ARGS,
      V8Path: v8Path,
      ObjectsFile: objectsFile,
      Revised: true,
    });

    assert.deepStrictEqual(request.args, [
      'DESIGNER',
      '/S', 'srv/db', '/NАдмин', '/Pdbpw',
      '/ConfigurationRepositoryF', '\\\\repo\\storage',
      '/ConfigurationRepositoryN', 'dev',
      '/ConfigurationRepositoryP', 'rp',
      '/ConfigurationRepositoryLock',
      '-Objects', { kind: 'inputFile', name: 'objects.xml', content: fs.readFileSync(objectsFile) },
      '-revised',
    ]);
    assert.deepStrictEqual(request.secrets, ['dbpw', 'rp']);
  });

  test('файловая база и пустой пароль хранилища: нет /ConfigurationRepositoryP', () => {
    const request = buildRepositoryCliRequest('repository-unbind', {
      InfoBasePath: 'C:\\Базы\\Тест',
      RepoPath: '\\\\repo\\storage',
      RepoUser: 'dev',
      V8Path: v8Path,
      Force: true,
    });

    assert.deepStrictEqual(request.args, [
      'DESIGNER',
      '/F', 'C:\\Базы\\Тест',
      '/ConfigurationRepositoryF', '\\\\repo\\storage',
      '/ConfigurationRepositoryN', 'dev',
      '/ConfigurationRepositoryUnbindCfg',
      '-force',
    ]);
    assert.deepStrictEqual(request.secrets, []);
  });

  // Байты, которые чтение как UTF-8 необратимо портит: BOM UTF-16, кириллица cp1251.
  const objectsEncodings: { title: string; bytes: Buffer }[] = [
    {
      title: 'UTF-16LE с BOM',
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(OBJECTS_XML, 'utf16le')]),
    },
    {
      title: 'cp1251',
      // «Справочник.Товары» в cp1251 — вручную: iconv в тесте не нужен ради одной строки.
      bytes: Buffer.concat([
        Buffer.from('<Objects version="1.0"><Object fullName="', 'ascii'),
        Buffer.from([0xd1, 0xef, 0xf0, 0xe0, 0xe2, 0xee, 0xf7, 0xed, 0xe8, 0xea, 0x2e, 0xd2, 0xee, 0xe2, 0xe0, 0xf0, 0xfb]),
        Buffer.from('"/></Objects>', 'ascii'),
      ]),
    },
  ];
  for (const item of objectsEncodings) {
    test(`ObjectsFile в ${item.title}: во входной файл исполнителя уходят исходные байты`, () => {
      fs.writeFileSync(objectsFile, item.bytes);
      for (const command of ['repository-lock', 'repository-unlock', 'repository-commit', 'repository-update'] as const) {
        const request = buildRepositoryCliRequest(command, { ...CONNECTION_ARGS, V8Path: v8Path, ObjectsFile: objectsFile });
        const input = request.args.find(
          (arg): arg is Extract<typeof arg, { kind: 'inputFile' }> => typeof arg !== 'string' && arg.kind === 'inputFile'
        );
        assert.ok(input, command);
        assert.ok(typeof input.content !== 'string', `${command}: содержимое не должно перекодироваться в строку`);
        assert.ok(Buffer.from(input.content).equals(item.bytes), `${command}: байты должны совпасть`);
      }
    });
  }

  test('пустой ObjectsFile — запуск без -Objects (как и без файла)', () => {
    fs.writeFileSync(objectsFile, Buffer.alloc(0));
    const request = buildRepositoryCliRequest('repository-lock', { ...CONNECTION_ARGS, V8Path: v8Path, ObjectsFile: objectsFile });
    assert.ok(!request.args.includes('-Objects'));
  });

  test('несуществующий ObjectsFile — ошибка, а не молчаливый запуск без -Objects', () => {
    assert.throws(
      () => parseRepositoryOperation('repository-lock', { ...CONNECTION_ARGS, ObjectsFile: path.join(tempDir, 'нет.xml') }),
      /ENOENT|не найден|ObjectsFile/i
    );
  });

  suite('обязательные аргументы CLI сохраняются', () => {
    const required: { command: RepositoryCliCommand; args: CliArgs; missing: RegExp }[] = [
      { command: 'repository-add-user', args: { Pwd: 'p', Rights: 'r' }, missing: /User is required/ },
      { command: 'repository-add-user', args: { User: 'u', Rights: 'r' }, missing: /Pwd is required/ },
      { command: 'repository-add-user', args: { User: 'u', Pwd: 'p' }, missing: /Rights is required/ },
      { command: 'repository-copy-users', args: { User: 'u', Pwd: 'p' }, missing: /Path is required/ },
      { command: 'repository-copy-users', args: { Path: 'x', Pwd: 'p' }, missing: /User is required/ },
      { command: 'repository-copy-users', args: { Path: 'x', User: 'u' }, missing: /Pwd is required/ },
      { command: 'repository-dump', args: {}, missing: /File is required/ },
      { command: 'repository-report', args: {}, missing: /File is required/ },
      { command: 'repository-set-label', args: {}, missing: /LabelName is required/ },
    ];
    for (const item of required) {
      test(`${item.command}: ${String(item.missing)}`, () => {
        assert.throws(() => parseRepositoryOperation(item.command, { ...CONNECTION_ARGS, ...item.args }), item.missing);
      });
    }
  });

  suite('подключение и хранилище из аргументов CLI', () => {
    test('нет ни InfoBasePath, ни InfoBaseServer+InfoBaseRef — ошибка разбора подключения', () => {
      assert.throws(
        () => buildRepositoryCliRequest('repository-bind', { RepoPath: 'p', RepoUser: 'u', V8Path: v8Path }),
        /InfoBasePath/
      );
    });

    test('нет RepoPath — ошибка', () => {
      assert.throws(
        () => buildRepositoryCliRequest('repository-bind', { InfoBasePath: 'C:\\b', RepoUser: 'u', V8Path: v8Path }),
        /RepoPath is required/
      );
    });

    test('нет RepoUser — ошибка', () => {
      assert.throws(
        () => buildRepositoryCliRequest('repository-bind', { InfoBasePath: 'C:\\b', RepoPath: 'p', V8Path: v8Path }),
        /RepoUser is required/
      );
    });
  });
});
