import * as assert from 'assert';
import { formatCommandLineForLog } from '../../infra/process';
import { describeDesignerArgs, type DesignerArg } from '../../infra/process/designer/DesignerBatchExecutor';
import {
  buildRepositoryDesignerRequest,
  repositoryOperationOutputName,
  repositoryReportOutputName,
  type RepositoryOperation,
} from '../../infra/repository/RepositoryDesignerArgs';
import type { RepositoryBinding } from '../../infra/repository/RepositoryService';

type Connection = Parameters<typeof buildRepositoryDesignerRequest>[0];

/**
 * Точный регресс-тест вектора пакетного конфигуратора для 12 операций хранилища.
 *
 * Эталон — литералы, снятые с прежней пары `buildCommandDesignerArgs` +
 * `runRepositoryCliCommand` (UI) и `repositoryCommands.ts` (CLI). Платформа молча
 * принимает и игнорирует неизвестные ключи (в т.ч. с ошибкой регистра), поэтому
 * единственная защита от опечатки в векторе — побайтное сравнение набора и ПОРЯДКА
 * аргументов, а не поведение процесса. Кириллица и кавычки в значениях нужны,
 * чтобы построитель не «чинил» их квотированием: квотирует исполнитель.
 */

const SERVER_CONNECTION: Connection = {
  infoBaseServer: 'srv',
  infoBaseRef: 'db',
  userName: 'Админ',
  password: 'dbpw',
};

const BINDING: RepositoryBinding = {
  repoPath: '\\\\repo\\storage',
  repoUser: 'dev',
  repoPassword: 'rp',
};

const SERVER_PREFIX: DesignerArg[] = [
  'DESIGNER',
  '/S', 'srv/db', '/NАдмин', '/Pdbpw',
  '/ConfigurationRepositoryF', '\\\\repo\\storage',
  '/ConfigurationRepositoryN', 'dev',
  '/ConfigurationRepositoryP', 'rp',
];

const OBJECTS_XML = '<Objects version="1.0">\n  <Object fullName="Справочник.Товары"/>\n</Objects>\n';
const OBJECTS_FILE: DesignerArg = { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_XML };
const COMMENT = 'Исправление "ошибки" №1';
/** UTF-16LE с BOM: такие байты нельзя прочитать как UTF-8 без порчи. */
const OBJECTS_BYTES = Uint8Array.from(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(OBJECTS_XML, 'utf16le')]));

interface OperationCase {
  readonly title: string;
  readonly op: RepositoryOperation;
  readonly tail: DesignerArg[];
  readonly userSecrets?: string[];
}

const OPERATION_CASES: readonly OperationCase[] = [
  // create
  { title: 'create: без флагов', op: { kind: 'create' }, tail: ['/ConfigurationRepositoryCreate'] },
  {
    title: 'create: все флаги, порядок фиксирован',
    op: {
      kind: 'create',
      allowConfigurationChanges: true,
      changesAllowedRule: 'ObjectsAllowed',
      changesNotRecommendedRule: 'ObjectNotRecommended',
      noBind: true,
    },
    tail: [
      '/ConfigurationRepositoryCreate',
      '-AllowConfigurationChanges',
      '-ChangesAllowedRule', 'ObjectsAllowed',
      '-ChangesNotRecommendedRule', 'ObjectNotRecommended',
      '-NoBind',
    ],
  },
  {
    title: 'create: только правила, пустые строки и false опускаются',
    op: {
      kind: 'create',
      allowConfigurationChanges: false,
      changesAllowedRule: '',
      changesNotRecommendedRule: 'ObjectNotRecommended',
      noBind: false,
    },
    tail: ['/ConfigurationRepositoryCreate', '-ChangesNotRecommendedRule', 'ObjectNotRecommended'],
  },
  // bind
  { title: 'bind: без флагов', op: { kind: 'bind' }, tail: ['/ConfigurationRepositoryBindCfg'] },
  {
    title: 'bind: forceBindAlreadyBindedUser',
    op: { kind: 'bind', forceBindAlreadyBindedUser: true },
    tail: ['/ConfigurationRepositoryBindCfg', '-forceBindAlreadyBindedUser'],
  },
  {
    title: 'bind: forceReplaceCfg',
    op: { kind: 'bind', forceReplaceCfg: true },
    tail: ['/ConfigurationRepositoryBindCfg', '-forceReplaceCfg'],
  },
  {
    title: 'bind: оба флага',
    op: { kind: 'bind', forceBindAlreadyBindedUser: true, forceReplaceCfg: true },
    tail: ['/ConfigurationRepositoryBindCfg', '-forceBindAlreadyBindedUser', '-forceReplaceCfg'],
  },
  // unbind
  { title: 'unbind: без флагов', op: { kind: 'unbind' }, tail: ['/ConfigurationRepositoryUnbindCfg'] },
  {
    title: 'unbind: force',
    op: { kind: 'unbind', force: true },
    tail: ['/ConfigurationRepositoryUnbindCfg', '-force'],
  },
  // lock
  { title: 'lock: без objectsXml', op: { kind: 'lock' }, tail: ['/ConfigurationRepositoryLock'] },
  {
    title: 'lock: пустой objectsXml не порождает -Objects',
    op: { kind: 'lock', objectsXml: '' },
    tail: ['/ConfigurationRepositoryLock'],
  },
  {
    title: 'lock: пустой Uint8Array не порождает -Objects',
    op: { kind: 'lock', objectsXml: new Uint8Array(0) },
    tail: ['/ConfigurationRepositoryLock'],
  },
  {
    title: 'lock: objectsXml байтами — уходит в inputFile без перекодировки',
    op: { kind: 'lock', objectsXml: OBJECTS_BYTES },
    tail: ['/ConfigurationRepositoryLock', '-Objects', { kind: 'inputFile', name: 'objects.xml', content: OBJECTS_BYTES }],
  },
  {
    title: 'lock: с objectsXml',
    op: { kind: 'lock', objectsXml: OBJECTS_XML },
    tail: ['/ConfigurationRepositoryLock', '-Objects', OBJECTS_FILE],
  },
  {
    title: 'lock: revised без objectsXml',
    op: { kind: 'lock', revised: true },
    tail: ['/ConfigurationRepositoryLock', '-revised'],
  },
  {
    title: 'lock: objectsXml и revised',
    op: { kind: 'lock', objectsXml: OBJECTS_XML, revised: true },
    tail: ['/ConfigurationRepositoryLock', '-Objects', OBJECTS_FILE, '-revised'],
  },
  // unlock
  { title: 'unlock: без objectsXml', op: { kind: 'unlock' }, tail: ['/ConfigurationRepositoryUnLock'] },
  {
    title: 'unlock: с objectsXml',
    op: { kind: 'unlock', objectsXml: OBJECTS_XML },
    tail: ['/ConfigurationRepositoryUnLock', '-Objects', OBJECTS_FILE],
  },
  {
    title: 'unlock: objectsXml и force',
    op: { kind: 'unlock', objectsXml: OBJECTS_XML, force: true },
    tail: ['/ConfigurationRepositoryUnLock', '-Objects', OBJECTS_FILE, '-force'],
  },
  {
    title: 'unlock: force без objectsXml',
    op: { kind: 'unlock', force: true },
    tail: ['/ConfigurationRepositoryUnLock', '-force'],
  },
  // commit
  { title: 'commit: без параметров', op: { kind: 'commit' }, tail: ['/ConfigurationRepositoryCommit'] },
  {
    title: 'commit: только objectsXml',
    op: { kind: 'commit', objectsXml: OBJECTS_XML },
    tail: ['/ConfigurationRepositoryCommit', '-Objects', OBJECTS_FILE],
  },
  {
    title: 'commit: пустой комментарий опускается',
    op: { kind: 'commit', objectsXml: OBJECTS_XML, comment: '' },
    tail: ['/ConfigurationRepositoryCommit', '-Objects', OBJECTS_FILE],
  },
  {
    title: 'commit: комментарий',
    op: { kind: 'commit', comment: COMMENT },
    tail: ['/ConfigurationRepositoryCommit', '-comment', COMMENT],
  },
  {
    title: 'commit: keepLocked',
    op: { kind: 'commit', keepLocked: true },
    tail: ['/ConfigurationRepositoryCommit', '-keepLocked'],
  },
  {
    title: 'commit: force',
    op: { kind: 'commit', force: true },
    tail: ['/ConfigurationRepositoryCommit', '-force'],
  },
  {
    title: 'commit: все параметры, порядок -Objects, -comment, -keepLocked, -force',
    op: { kind: 'commit', objectsXml: OBJECTS_XML, comment: COMMENT, keepLocked: true, force: true },
    tail: ['/ConfigurationRepositoryCommit', '-Objects', OBJECTS_FILE, '-comment', COMMENT, '-keepLocked', '-force'],
  },
  // update
  { title: 'update: без параметров', op: { kind: 'update' }, tail: ['/ConfigurationRepositoryUpdateCfg'] },
  {
    title: 'update: только objectsXml',
    op: { kind: 'update', objectsXml: OBJECTS_XML },
    tail: ['/ConfigurationRepositoryUpdateCfg', '-Objects', OBJECTS_FILE],
  },
  {
    title: 'update: версия',
    op: { kind: 'update', version: '42' },
    tail: ['/ConfigurationRepositoryUpdateCfg', '-v', '42'],
  },
  {
    title: 'update: пустая версия опускается, force',
    op: { kind: 'update', version: '', force: true },
    tail: ['/ConfigurationRepositoryUpdateCfg', '-force'],
  },
  {
    title: 'update: все параметры, порядок -Objects, -v, -force',
    op: { kind: 'update', objectsXml: OBJECTS_XML, version: '7', force: true },
    tail: ['/ConfigurationRepositoryUpdateCfg', '-Objects', OBJECTS_FILE, '-v', '7', '-force'],
  },
  // addUser
  {
    title: 'addUser: только пользователь',
    op: { kind: 'addUser', user: 'Иванов' },
    tail: ['/ConfigurationRepositoryAddUser', '-User', 'Иванов'],
  },
  {
    title: 'addUser: пустые пароль и права опускаются',
    op: { kind: 'addUser', user: 'Иванов', password: '', rights: '' },
    tail: ['/ConfigurationRepositoryAddUser', '-User', 'Иванов'],
  },
  {
    title: 'addUser: все параметры, пароль пользователя попадает в secrets',
    op: { kind: 'addUser', user: 'Иванов', password: 'upw', rights: 'LockObjects', restoreDeletedUser: true },
    tail: [
      '/ConfigurationRepositoryAddUser',
      '-User', 'Иванов',
      '-Pwd', 'upw',
      '-Rights', 'LockObjects',
      '-RestoreDeletedUser',
    ],
    userSecrets: ['upw'],
  },
  // copyUsers
  {
    title: 'copyUsers: без пароля',
    op: { kind: 'copyUsers', path: 'C:\\src repo', user: 'Админ' },
    tail: ['/ConfigurationRepositoryCopyUsers', '-Path', 'C:\\src repo', '-User', 'Админ'],
  },
  {
    title: 'copyUsers: пароль и restoreDeletedUser',
    op: { kind: 'copyUsers', path: 'C:\\src repo', user: 'Админ', password: 'upw', restoreDeletedUser: true },
    tail: [
      '/ConfigurationRepositoryCopyUsers',
      '-Path', 'C:\\src repo',
      '-User', 'Админ',
      '-Pwd', 'upw',
      '-RestoreDeletedUser',
    ],
    userSecrets: ['upw'],
  },
  // dump
  {
    title: 'dump: без версии — выходной файл объявлен построителем',
    op: { kind: 'dump' },
    tail: ['/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }],
  },
  {
    title: 'dump: с версией',
    op: { kind: 'dump', version: '15' },
    tail: ['/ConfigurationRepositoryDumpCfg', { kind: 'outputFile', name: 'dump.cf' }, '-v', '15'],
  },
  // report
  {
    title: 'report: без параметров — staging-файл .mxl (умолчание платформы)',
    op: { kind: 'report' },
    tail: ['/ConfigurationRepositoryReport', { kind: 'outputFile', name: 'report.mxl' }],
  },
  {
    title: 'report: формат txt — staging-файл .txt',
    op: { kind: 'report', reportFormat: 'txt' },
    tail: ['/ConfigurationRepositoryReport', { kind: 'outputFile', name: 'report.txt' }, '-ReportFormat', 'txt'],
  },
  {
    title: 'report: все параметры, порядок фиксирован',
    op: {
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
    },
    tail: [
      '/ConfigurationRepositoryReport', { kind: 'outputFile', name: 'report.txt' },
      '-NBegin', '1',
      '-NEnd', '9',
      '-DateBegin', '2024-01-01',
      '-DateEnd', '2024-12-31',
      '-ConfigurationVersion', '1.2.3',
      '-ReportFormat', 'txt',
      '-GroupByObject',
      '-GroupByComment',
      '-DoNotIncludeVersionsWithLabels',
      '-IncludeOnlyVersionsWithLabels',
      '-IncludeCommentLinesWithDoubleSlash',
    ],
  },
  {
    title: 'report: пустые строки опускаются, false-флаги не пишутся',
    op: { kind: 'report', nBegin: '', reportFormat: 'mxl', groupByObject: false },
    tail: ['/ConfigurationRepositoryReport', { kind: 'outputFile', name: 'report.mxl' }, '-ReportFormat', 'mxl'],
  },
  // setLabel
  {
    title: 'setLabel: только имя',
    op: { kind: 'setLabel', name: 'Релиз 1' },
    tail: ['/ConfigurationRepositorySetLabel', '-name', 'Релиз 1'],
  },
  {
    title: 'setLabel: версия и комментарий',
    op: { kind: 'setLabel', name: 'Релиз 1', version: '3', comment: COMMENT },
    tail: ['/ConfigurationRepositorySetLabel', '-name', 'Релиз 1', '-v', '3', '-comment', COMMENT],
  },
  {
    title: 'setLabel: пустые версия и комментарий опускаются',
    op: { kind: 'setLabel', name: 'Релиз 1', version: '', comment: '' },
    tail: ['/ConfigurationRepositorySetLabel', '-name', 'Релиз 1'],
  },
];

const EXTENSION_VARIANTS: readonly { title: string; extension: string | undefined; suffix: DesignerArg[] }[] = [
  { title: 'без расширения', extension: undefined, suffix: [] },
  { title: 'пустое имя расширения не порождает -Extension', extension: '', suffix: [] },
  { title: 'с расширением', extension: 'EVOLC', suffix: ['-Extension', 'EVOLC'] },
];

function stringify(args: readonly DesignerArg[]): string[] {
  return args.map((arg) => (typeof arg === 'string' ? arg : `<${arg.kind}:${arg.name}>`));
}

suite('RepositoryDesignerArgs — единый построитель вектора хранилища', () => {
  suite('вектор: операция × расширение', () => {
    for (const variant of EXTENSION_VARIANTS) {
      for (const item of OPERATION_CASES) {
        test(`${item.title} (${variant.title})`, () => {
          const request = buildRepositoryDesignerRequest(SERVER_CONNECTION, BINDING, item.op, variant.extension);

          assert.deepStrictEqual(request.args, [...SERVER_PREFIX, ...item.tail, ...variant.suffix]);
          assert.deepStrictEqual(request.secrets, ['dbpw', 'rp', ...(item.userSecrets ?? [])]);
        });
      }
    }
  });

  suite('вектор не содержит того, что добавляет исполнитель', () => {
    test('первый элемент — DESIGNER, нет исполняемого файла, /Out и /DisableStartupDialogs', () => {
      for (const item of OPERATION_CASES) {
        const strings = stringify(buildRepositoryDesignerRequest(SERVER_CONNECTION, BINDING, item.op, 'EVOLC').args);
        assert.strictEqual(strings[0], 'DESIGNER', item.title);
        assert.ok(!strings.some((s) => /^\/out$/i.test(s)), `${item.title}: /Out добавляет исполнитель`);
        assert.ok(
          !strings.some((s) => /^\/DisableStartupDialogs$/i.test(s)),
          `${item.title}: /DisableStartupDialogs добавляет исполнитель`
        );
        assert.ok(!strings.some((s) => /1cv8/i.test(s)), `${item.title}: исполняемого файла в векторе нет`);
      }
    });

    test('запрос не несёт отмену и обратный вызов — их задаёт вызывающий', () => {
      const request = buildRepositoryDesignerRequest(SERVER_CONNECTION, BINDING, { kind: 'bind' });
      assert.strictEqual(request.cancellation, undefined);
      assert.strictEqual(request.onOutput, undefined);
    });
  });

  suite('подключение к информационной базе', () => {
    const lock: RepositoryOperation = { kind: 'lock' };
    const repoTail: DesignerArg[] = [
      '/ConfigurationRepositoryF', '\\\\repo\\storage',
      '/ConfigurationRepositoryN', 'dev',
      '/ConfigurationRepositoryP', 'rp',
      '/ConfigurationRepositoryLock',
    ];

    const connectionCases: { title: string; connection: Connection; head: string[]; dbSecrets: string[] }[] = [
      {
        title: 'серверная база: /S сервер/ссылка, /N и /P слитно',
        connection: SERVER_CONNECTION,
        head: ['/S', 'srv/db', '/NАдмин', '/Pdbpw'],
        dbSecrets: ['dbpw'],
      },
      {
        title: 'файловая база: /F путь',
        connection: { infoBasePath: 'C:\\Базы\\Тест', userName: 'Админ', password: 'dbpw' },
        head: ['/F', 'C:\\Базы\\Тест', '/NАдмин', '/Pdbpw'],
        dbSecrets: ['dbpw'],
      },
      {
        title: 'пустой пароль базы: нет /P и секрета',
        connection: { infoBaseServer: 'srv', infoBaseRef: 'db', userName: 'Админ', password: '' },
        head: ['/S', 'srv/db', '/NАдмин'],
        dbSecrets: [],
      },
      {
        title: 'пароль базы не задан (undefined): нет /P и секрета',
        connection: { infoBaseServer: 'srv', infoBaseRef: 'db', userName: 'Админ' },
        head: ['/S', 'srv/db', '/NАдмин'],
        dbSecrets: [],
      },
      {
        title: 'пустой пользователь: нет /N, пароль есть',
        connection: { infoBasePath: 'C:\\base', userName: '', password: 'dbpw' },
        head: ['/F', 'C:\\base', '/Pdbpw'],
        dbSecrets: ['dbpw'],
      },
      {
        title: 'ни пользователя, ни пароля',
        connection: { infoBasePath: 'C:\\base' },
        head: ['/F', 'C:\\base'],
        dbSecrets: [],
      },
      {
        title: 'сервер без ссылки, но есть путь: берётся /F',
        connection: { infoBaseServer: 'srv', infoBasePath: 'C:\\base' },
        head: ['/F', 'C:\\base'],
        dbSecrets: [],
      },
      {
        title: 'ссылка без сервера, но есть путь: берётся /F',
        connection: { infoBaseRef: 'db', infoBasePath: 'C:\\base' },
        head: ['/F', 'C:\\base'],
        dbSecrets: [],
      },
      {
        title: 'сервер и путь заданы: приоритет у пары /S',
        connection: { infoBaseServer: 'srv', infoBaseRef: 'db', infoBasePath: 'C:\\base' },
        head: ['/S', 'srv/db'],
        dbSecrets: [],
      },
    ];

    for (const item of connectionCases) {
      test(item.title, () => {
        const request = buildRepositoryDesignerRequest(item.connection, BINDING, lock);
        assert.deepStrictEqual(request.args, ['DESIGNER', ...item.head, ...repoTail]);
        assert.deepStrictEqual(request.secrets, [...item.dbSecrets, 'rp']);
      });
    }

    const brokenConnections: { title: string; connection: Connection }[] = [
      { title: 'пустой объект', connection: {} },
      { title: 'только сервер без ссылки', connection: { infoBaseServer: 'srv' } },
      { title: 'только ссылка без сервера', connection: { infoBaseRef: 'db' } },
      { title: 'пустые строки', connection: { infoBaseServer: '', infoBaseRef: '', infoBasePath: '' } },
    ];
    for (const item of brokenConnections) {
      test(`нет ни /S-пары, ни /F — ошибка (${item.title})`, () => {
        assert.throws(
          () => buildRepositoryDesignerRequest(item.connection, BINDING, lock),
          /подключения к базе/
        );
      });
    }
  });

  suite('подключение к хранилищу', () => {
    test('пустой пароль хранилища: нет /ConfigurationRepositoryP и секрета', () => {
      const request = buildRepositoryDesignerRequest(
        SERVER_CONNECTION,
        { ...BINDING, repoPassword: '' },
        { kind: 'unbind' }
      );
      assert.deepStrictEqual(request.args, [
        'DESIGNER',
        '/S', 'srv/db', '/NАдмин', '/Pdbpw',
        '/ConfigurationRepositoryF', '\\\\repo\\storage',
        '/ConfigurationRepositoryN', 'dev',
        '/ConfigurationRepositoryUnbindCfg',
      ]);
      assert.deepStrictEqual(request.secrets, ['dbpw']);
    });

    test('пустые пароли базы и хранилища: секретов нет вовсе', () => {
      const request = buildRepositoryDesignerRequest(
        { infoBasePath: 'C:\\base' },
        { ...BINDING, repoPassword: '' },
        { kind: 'addUser', user: 'u' }
      );
      assert.deepStrictEqual(request.secrets, []);
    });

    test('секреты идут в порядке: база, хранилище, пользователь операции', () => {
      const request = buildRepositoryDesignerRequest(
        SERVER_CONNECTION,
        BINDING,
        { kind: 'copyUsers', path: 'p', user: 'u', password: 'userpw' }
      );
      assert.deepStrictEqual(request.secrets, ['dbpw', 'rp', 'userpw']);
    });
  });

  suite('имя выходного файла операции', () => {
    const reportCases: { title: string; op: Parameters<typeof repositoryReportOutputName>[0]; expected: string }[] = [
      // Замер 8.3.27.2130: формат задаёт только -ReportFormat, без него платформа пишет MXL.
      { title: 'формат mxl', op: { reportFormat: 'mxl' }, expected: 'report.mxl' },
      { title: 'формат txt', op: { reportFormat: 'txt' }, expected: 'report.txt' },
      { title: 'формат txt в другом регистре и с пробелами', op: { reportFormat: ' TXT ' }, expected: 'report.txt' },
      { title: 'формат mxl в другом регистре и с пробелами', op: { reportFormat: ' MXL ' }, expected: 'report.mxl' },
      { title: 'пустой формат — умолчание MXL', op: { reportFormat: '' }, expected: 'report.mxl' },
      { title: 'неизвестный формат — умолчание MXL', op: { reportFormat: 'xls' }, expected: 'report.mxl' },
      { title: 'формат не задан — умолчание MXL', op: {}, expected: 'report.mxl' },
    ];
    for (const item of reportCases) {
      test(`report: ${item.title} → ${item.expected}`, () => {
        assert.strictEqual(repositoryReportOutputName(item.op), item.expected);
      });
    }

    test('dump → dump.cf, report → имя по формату, прочие операции — без выходного файла', () => {
      assert.strictEqual(repositoryOperationOutputName({ kind: 'dump' }), 'dump.cf');
      assert.strictEqual(repositoryOperationOutputName({ kind: 'report', reportFormat: 'mxl' }), 'report.mxl');
      assert.strictEqual(repositoryOperationOutputName({ kind: 'report', reportFormat: 'txt' }), 'report.txt');
      assert.strictEqual(repositoryOperationOutputName({ kind: 'report' }), 'report.mxl');
      for (const op of [{ kind: 'lock' }, { kind: 'bind' }, { kind: 'setLabel', name: 'x' }] as RepositoryOperation[]) {
        assert.strictEqual(repositoryOperationOutputName(op), undefined, op.kind);
      }
    });

    test('ключ выходного файла совпадает с outputFile в векторе', () => {
      for (const op of [{ kind: 'dump' }, { kind: 'report' }, { kind: 'report', reportFormat: 'txt' }] as RepositoryOperation[]) {
        const output = buildRepositoryDesignerRequest(SERVER_CONNECTION, BINDING, op).args
          .find((arg): arg is Exclude<DesignerArg, string> => typeof arg !== 'string' && arg.kind === 'outputFile');
        assert.strictEqual(output?.name, repositoryOperationOutputName(op));
      }
    });
  });

  suite('describeDesignerArgs — вектор для журнала', () => {
    test('файлы показываются именем, содержимое входного файла в журнал не попадает', () => {
      const request = buildRepositoryDesignerRequest(SERVER_CONNECTION, BINDING, { kind: 'lock', objectsXml: OBJECTS_XML });
      const described = describeDesignerArgs(request.args);
      assert.deepStrictEqual(described.slice(-3), ['/ConfigurationRepositoryLock', '-Objects', '<objects.xml>']);
      assert.ok(!described.some((s) => s.includes('Справочник.Товары')));
      assert.deepStrictEqual(
        describeDesignerArgs(buildRepositoryDesignerRequest(SERVER_CONNECTION, BINDING, { kind: 'dump' }).args).slice(-2),
        ['/ConfigurationRepositoryDumpCfg', '<dump.cf>']
      );
    });
  });

  suite('маскирование секретов в журнале', () => {
    test('formatCommandLineForLog по secrets не оставляет ни одного значения пароля (в т.ч. со слешем и кавычкой)', () => {
      const dbPassword = 'p@ss/dbpw';
      const repoPassword = 'repo/pw"x';
      const userPassword = 'user pw/1';
      const request = buildRepositoryDesignerRequest(
        { infoBaseServer: 'srv', infoBaseRef: 'db', userName: 'Админ', password: dbPassword },
        { repoPath: '\\\\repo\\storage', repoUser: 'dev', repoPassword },
        { kind: 'addUser', user: 'Иванов', password: userPassword, rights: 'Administration' }
      );

      // Значения действительно лежат в векторе открытым текстом — иначе проверка маски пуста.
      const strings = stringify(request.args);
      for (const secret of [dbPassword, repoPassword, userPassword]) {
        assert.ok(strings.some((s) => s.includes(secret)), `секрет "${secret}" должен быть в векторе`);
      }

      const line = formatCommandLineForLog('1cv8.exe', strings, request.secrets);
      for (const secret of [dbPassword, repoPassword, userPassword]) {
        assert.ok(!line.includes(secret), `в журнале не должно быть "${secret}": ${line}`);
      }
    });
  });
});
