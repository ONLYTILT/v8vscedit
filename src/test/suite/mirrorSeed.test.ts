import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentConfigurationOperationTarget } from '../../infra/agent/AgentOperationService';
import type { AgentFileStore } from '../../infra/agent/files/AgentFileStore';
import { LocalAgentFileStore } from '../../infra/agent/files/LocalAgentFileStore';
import { createLocalExchange } from '../../infra/agent/sync/LocalExchange';
import { inspectProjectMirrorSeed, seedMirror, type MirrorSeedRejection } from '../../infra/agent/sync/MirrorSeed';
import type { SyncOperationContext } from '../../infra/agent/sync/SyncContext';
import type { SyncMirrorCoverage } from '../../infra/agent/sync/SyncManifest';
import { ConfigXmlReader } from '../../infra/xml/ConfigXmlReader';
import { AgentConfigEmulator } from './support/agentConfigEmulator';
import { EXAMPLE_GENERATIONS, skipWithoutCorpus } from './support/corpus';
import { DelegatingAgentFileStore } from './support/delegatingAgentFileStore';

/**
 * Посев зеркала M. `inspectProjectMirrorSeed` — дешёвые проверки пригодности выгрузки проекта ДО
 * вопроса пользователю (файл версий и Configuration.xml на месте, вид и имя совпадают с целью, формат
 * Hierarchical, версия известна и одинакова у обоих файлов), без чтения 33 МБ целиком. `seedMirror` —
 * запись основы M: очистка, Configuration.xml, файл версий ПОСЛЕДНИМ (по нему M признаётся достоверным).
 */

suite('MirrorSeed.inspectProjectMirrorSeed', function () {
  this.timeout(60_000);
  let tmp: string;
  let project: string;
  let emulator: AgentConfigEmulator;

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-mirror-seed-'));
    project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    emulator = new AgentConfigEmulator(path.join(tmp, 'user-root'));
    emulator.setObject('Catalog.Товары', { 'Catalogs/Товары.xml': '<Catalog>Товары</Catalog>' });
  });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  const targetOf = (kind: 'cf' | 'cfe', name: string): AgentConfigurationOperationTarget => ({ kind, name, rootPath: project });
  const cdiPath = (): string => path.join(project, 'ConfigDumpInfo.xml');
  const cfgPath = (): string => path.join(project, 'Configuration.xml');

  /** Выгрузка проекта: реалистичные Configuration.xml и файл версий. */
  function seedProject(kind: 'cf' | 'cfe', name: string, version = '2.20'): void {
    emulator.formatVersion = version;
    emulator.setConfiguration(name, kind);
    emulator.snapshotToProject(project);
  }

  function reject(result: ReturnType<typeof inspectProjectMirrorSeed>): MirrorSeedRejection | undefined {
    return result.ok ? undefined : result.reason;
  }

  for (const kind of ['cf', 'cfe'] as const) {
    const name = kind === 'cf' ? 'Основная' : 'Расш';

    suite(`цель ${kind}`, () => {
      test('пригодная выгрузка: кандидат с видом, именем, версией, датой и размером файла версий', () => {
        seedProject(kind, name);
        const result = inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined);
        assert.ok(result.ok);
        assert.strictEqual(result.candidate.targetKind, kind);
        assert.strictEqual(result.candidate.targetName, name);
        assert.strictEqual(result.candidate.projectDir, project);
        assert.strictEqual(result.candidate.formatVersion, '2.20');
        assert.strictEqual(result.candidate.dumpInfoSize, fs.statSync(cdiPath()).size);
        assert.strictEqual(result.candidate.dumpInfoModifiedAt.getTime(), fs.statSync(cdiPath()).mtime.getTime());
      });

      test('другая известная версия формата (2.21) у обоих файлов — пригодна', () => {
        seedProject(kind, name, '2.21');
        const result = inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined);
        assert.ok(result.ok);
        assert.strictEqual(result.candidate.formatVersion, '2.21');
      });

      test('нет файла версий → missing-dump-info (с сообщением для журнала)', () => {
        seedProject(kind, name);
        fs.unlinkSync(cdiPath());
        const result = inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined);
        assert.strictEqual(reject(result), 'missing-dump-info');
        assert.ok(!result.ok && result.message.length > 0);
      });

      test('нет Configuration.xml → missing-configuration', () => {
        seedProject(kind, name);
        fs.unlinkSync(cfgPath());
        assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined)), 'missing-configuration');
      });

      test('имя в Configuration.xml не совпадает с целью → name-mismatch', () => {
        seedProject(kind, 'ДругоеИмя');
        assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined)), 'name-mismatch');
      });

      test('формат файла версий не Hierarchical → dump-format', () => {
        seedProject(kind, name);
        fs.writeFileSync(cdiPath(), fs.readFileSync(cdiPath(), 'utf-8').replace('Hierarchical', 'Plain'));
        assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined)), 'dump-format');
      });

      test('версия формата неизвестна проекту (у обоих файлов 9.99) → format-unknown', () => {
        seedProject(kind, name, '9.99');
        assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined)), 'format-unknown');
      });

      test('версия файла версий (2.20) не равна версии Configuration.xml (2.21) → format-mismatch', () => {
        seedProject(kind, name, '2.20');
        fs.writeFileSync(cfgPath(), fs.readFileSync(cfgPath(), 'utf-8').replace('version="2.20"', 'version="2.21"'));
        assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf(kind, name), kind === 'cfe' ? name : undefined)), 'format-mismatch');
      });
    });
  }

  test('вид не совпадает с целью — в обе стороны: проект cf при цели cfe и проект cfe при цели cf → kind-mismatch', () => {
    seedProject('cf', 'Расш');
    assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf('cfe', 'Расш'), 'Расш')), 'kind-mismatch');
    seedProject('cfe', 'Основная');
    assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf('cf', 'Основная'), undefined)), 'kind-mismatch');
  });

  test('расширение: имя сверяется с extensionName, а при его отсутствии — с именем цели', () => {
    seedProject('cfe', 'Расш');
    assert.ok(inspectProjectMirrorSeed(targetOf('cfe', 'Расш'), undefined).ok, 'extensionName не задан → name цели');
    assert.ok(inspectProjectMirrorSeed(targetOf('cfe', 'ИмяЦели'), 'Расш').ok, 'extensionName важнее имени цели');
    assert.strictEqual(reject(inspectProjectMirrorSeed(targetOf('cfe', 'Расш'), 'Чужое')), 'name-mismatch');
  });

  test('каталога проекта нет → отказ по отсутствию файлов (не исключение)', () => {
    const result = inspectProjectMirrorSeed({ kind: 'cf', name: 'Основная', rootPath: path.join(tmp, 'нет') }, undefined);
    assert.ok(['missing-dump-info', 'missing-configuration'].includes(reject(result) ?? ''), String(reject(result)));
  });

  test('файл версий с мусором вместо заголовка → отказ (не пригоден для посева)', () => {
    seedProject('cf', 'Основная');
    fs.writeFileSync(cdiPath(), 'мусор');
    assert.strictEqual(inspectProjectMirrorSeed(targetOf('cf', 'Основная'), undefined).ok, false);
  });

  test('огромный файл версий (заголовок + 10 МБ): проверка читает только префикс, а не файл целиком', () => {
    seedProject('cf', 'Основная');
    fs.appendFileSync(cdiPath(), Buffer.alloc(10 * 1024 * 1024, 0x20));
    // Шов — сам CJS-модуль `fs` (импорт `import * as fs` в production — getter-обёртка __importStar,
    // подмена через неё не видна): считаются байты, запрошенные readSync, и пути readFileSync.
    const fsModule = require('fs') as Record<string, unknown>;
    const originalReadSync = fs.readSync;
    const originalReadFileSync = fs.readFileSync;
    const requested: number[] = [];
    const wholeReads: string[] = [];
    // Production читает префикс позиционной формой readSync(fd, buffer, offset, length, position).
    fsModule.readSync = (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: fs.ReadPosition | null): number => {
      requested.push(length);
      return originalReadSync(fd, buffer, offset, length, position);
    };
    fsModule.readFileSync = (...args: Parameters<typeof fs.readFileSync>): ReturnType<typeof fs.readFileSync> => {
      wholeReads.push(String(args[0]));
      return originalReadFileSync(...args);
    };
    let result: ReturnType<typeof inspectProjectMirrorSeed>;
    try {
      result = inspectProjectMirrorSeed(targetOf('cf', 'Основная'), undefined);
    } finally {
      fsModule.readSync = originalReadSync;
      fsModule.readFileSync = originalReadFileSync;
    }
    assert.ok(result.ok);
    assert.strictEqual(result.candidate.dumpInfoSize, fs.statSync(cdiPath()).size);
    assert.ok(requested.length > 0 && requested.every((length) => length <= 8 * 1024), `запрошено: ${requested.join(', ')}`);
    assert.ok(!wholeReads.some((file) => path.resolve(file) === path.resolve(cdiPath())), 'файл версий целиком не читается');
  });

  suite('реальный корпус example/2.20/src/cf (только чтение)', () => {
    setup(function () { skipWithoutCorpus(this, EXAMPLE_GENERATIONS.cf20, path.join(EXAMPLE_GENERATIONS.cf20, 'ConfigDumpInfo.xml')); });

    test('выгрузка платформы пригодна для посева, версия 2.20', () => {
      const info = new ConfigXmlReader().read(path.join(EXAMPLE_GENERATIONS.cf20, 'Configuration.xml'));
      const result = inspectProjectMirrorSeed({ kind: 'cf', name: info.name, rootPath: EXAMPLE_GENERATIONS.cf20 }, undefined);
      assert.ok(result.ok, result.ok ? '' : result.message);
      assert.strictEqual(result.candidate.formatVersion, '2.20');
    });
  });
});

/** Журнал порядка мутаций: `markMirrorMutated`, `remove`, `mkdirp`, запись файлов — в одном списке. */
class OrderRecordingStore extends DelegatingAgentFileStore {
  constructor(inner: AgentFileStore, readonly log: string[], private readonly failOn?: string) { super(inner); }
  override remove(rel: string, options?: { readonly recursive?: boolean }): Promise<void> {
    this.log.push(`remove:${rel}`);
    return super.remove(rel, options);
  }
  override mkdirp(rel: string): Promise<void> {
    this.log.push(`mkdirp:${rel}`);
    return super.mkdirp(rel);
  }
  override writeFile(rel: string, data: Uint8Array | string): Promise<void> {
    this.log.push(`writeFile:${rel}`);
    return this.failOn !== undefined && rel.endsWith(this.failOn) ? Promise.reject(new Error(`сбой записи ${rel}`)) : super.writeFile(rel, data);
  }
  override uploadFromFile(localPath: string, rel: string, options?: Parameters<AgentFileStore['uploadFromFile']>[2]): Promise<void> {
    this.log.push(`uploadFromFile:${rel}`);
    return this.failOn !== undefined && rel.endsWith(this.failOn) ? Promise.reject(new Error(`сбой закачки ${rel}`)) : super.uploadFromFile(localPath, rel, options);
  }
}

suite('MirrorSeed.seedMirror', function () {
  this.timeout(60_000);
  let tmp: string;
  let userRoot: string;
  const MIRROR = 'workspace/p1/cf';

  setup(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v8-seed-mirror-'));
    userRoot = path.join(tmp, 'user-root');
    fs.mkdirSync(userRoot);
  });
  teardown(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  function contextOf(store: AgentFileStore, log: string[], coverage: SyncMirrorCoverage = 'full'): SyncOperationContext {
    // Контекст операции — данные движка, а не внешняя система: нужные seedMirror поля собраны вручную.
    return {
      store,
      workspace: { targetAgentDir: MIRROR, exchangeRoot: 'exchange', listsRoot: 'lists', workspaceRoot: 'workspace/p1', projectId: 'p1' },
      markMirrorMutated: () => { log.push('mutated'); },
      mirror: { coverage },
      localExchange: createLocalExchange(path.join(tmp, 'local-exchange'), 'cf-1'),
      transferConcurrency: 4,
      hooks: undefined,
      operationId: 'cf-1',
    } as unknown as SyncOperationContext;
  }

  const CONFIG = '<Configuration>основа</Configuration>';
  const CDI = '<ConfigDumpInfo version="2.20" format="Hierarchical"/>';

  function localSources(): { configuration: string; dumpInfo: string } {
    const configuration = path.join(tmp, 'Configuration.xml');
    const dumpInfo = path.join(tmp, 'ConfigDumpInfo.xml');
    fs.writeFileSync(configuration, CONFIG);
    fs.writeFileSync(dumpInfo, CDI);
    return { configuration, dumpInfo };
  }

  const variants = [
    { label: 'локальные файлы проекта (uploadFromFile)', write: 'uploadFromFile', sources: localSources },
    { label: 'данные из архива (writeFile)', write: 'writeFile', sources: () => ({ configuration: Buffer.from(CONFIG), dumpInfo: Buffer.from(CDI) }) },
  ] as const;

  for (const variant of variants) {
    suite(variant.label, () => {
      test('порядок: markMirrorMutated → remove(M) → mkdirp(M) → Configuration.xml → ConfigDumpInfo.xml ПОСЛЕДНИМ; M содержит ровно два файла; полнота sparse', async () => {
        fs.mkdirSync(path.join(userRoot, ...MIRROR.split('/'), 'Catalogs'), { recursive: true });
        fs.writeFileSync(path.join(userRoot, ...MIRROR.split('/'), 'Catalogs', 'Остаток.xml'), '<stale/>');
        const log: string[] = [];
        const store = new OrderRecordingStore(new LocalAgentFileStore(userRoot), log);
        const context = contextOf(store, log);

        await seedMirror(context, variant.sources());

        assert.deepStrictEqual(log, [
          'mutated',
          `remove:${MIRROR}`,
          `mkdirp:${MIRROR}`,
          `${variant.write}:${MIRROR}/Configuration.xml`,
          `${variant.write}:${MIRROR}/ConfigDumpInfo.xml`,
        ]);
        const mirror = path.join(userRoot, ...MIRROR.split('/'));
        assert.deepStrictEqual(fs.readdirSync(mirror).sort(), ['ConfigDumpInfo.xml', 'Configuration.xml']);
        assert.strictEqual(fs.readFileSync(path.join(mirror, 'Configuration.xml'), 'utf-8'), CONFIG);
        assert.strictEqual(fs.readFileSync(path.join(mirror, 'ConfigDumpInfo.xml'), 'utf-8'), CDI);
        assert.strictEqual(context.mirror.coverage, 'sparse');
      });

      test('сбой записи файла версий: M без него (недостоверен), полнота уже sparse (M очищен), ошибка пробрасывается', async () => {
        const log: string[] = [];
        const store = new OrderRecordingStore(new LocalAgentFileStore(userRoot), log, 'ConfigDumpInfo.xml');
        const context = contextOf(store, log, 'full');

        await assert.rejects(seedMirror(context, variant.sources()), /ConfigDumpInfo\.xml/);

        assert.strictEqual(fs.existsSync(path.join(userRoot, ...MIRROR.split('/'), 'ConfigDumpInfo.xml')), false);
        // Изменено по замечанию ревьюера: начатый посев делает M разреженным сразу — иначе манифест
        // после сбоя сохранил бы прежнее `full`, и следующие операции удаляли бы по отсутствию в M.
        assert.strictEqual(context.mirror.coverage, 'sparse');
        assert.strictEqual(log[0], 'mutated', 'M помечен изменённым ДО первой мутации');
      });

      test('сбой записи Configuration.xml: файл версий не записан (иначе M признали бы достоверным)', async () => {
        const log: string[] = [];
        const store = new OrderRecordingStore(new LocalAgentFileStore(userRoot), log, 'Configuration.xml');
        await assert.rejects(seedMirror(contextOf(store, log), variant.sources()), /Configuration\.xml/);
        assert.ok(!log.some((entry) => entry.endsWith('ConfigDumpInfo.xml')));
      });
    });
  }

  test('смешанный источник (Configuration.xml — путь, файл версий — данные) допустим: каждый поле пишется своим способом', async () => {
    const log: string[] = [];
    const store = new OrderRecordingStore(new LocalAgentFileStore(userRoot), log);
    await seedMirror(contextOf(store, log), { configuration: localSources().configuration, dumpInfo: Buffer.from(CDI) });
    assert.deepStrictEqual(log.slice(-2), [`uploadFromFile:${MIRROR}/Configuration.xml`, `writeFile:${MIRROR}/ConfigDumpInfo.xml`]);
  });
});
