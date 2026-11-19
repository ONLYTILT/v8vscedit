/**
 * Общие стенды задачи «импорт при FullDump без полной выгрузки» (plan-fulldump-avoid.md, ред. 2): сценарии
 * «удалён владелец / переименован / удалена форма / удалена часть корня» поверх стенда движка и эмулятора
 * агента, классификация команд выгрузки по виду и общие проверки «ОБЩЕЕ» из §6 плана.
 *
 * Агент здесь эмулятор, хранилище — настоящее (SFTP на ssh2.Server или локальное), подменяется только 1С.
 */
import * as assert from 'assert';
import { buildSyncManifestFiles, type SyncMirrorCoverage } from '../../../infra/agent/sync/SyncManifest';
import { hasOption, type AgentConfigEmulator, type ParsedAgentCommand } from './agentConfigEmulator';
import {
  createHarness,
  dbAsText,
  HARNESS_EXTENSION_NAME,
  type HarnessKind,
  type HarnessOptions,
  type HarnessTargetKind,
  type SyncHarness,
} from './agentSyncHarness';

export const COVERAGES: readonly SyncMirrorCoverage[] = ['full', 'sparse'];

/** Режимы `dump --update` эмулятора при пропавших записях известного CDI. */
export const FULL_DUMP_UPDATE_MODES = ['rewrite-all', 'changed-and-removals'] as const;

/** Часть корня конфигурации (файл `Ext/…`): корень чистить нельзя, поэтому такое удаление идёт запасным путём. */
export const ROOT_PART_FILE = 'Ext/HomePageWorkArea.xml';

/** Файлы формы документа `Заказ` из стандартной «базы»: две файловые записи CDI (`Form.Форма`, `Form.Форма.Form`). */
export const ORDER_FORM_FILES: readonly string[] = [
  'Documents/Заказ/Forms/Форма.xml',
  'Documents/Заказ/Forms/Форма/Ext/Form.xml',
];

/** Файлы удалённого владельца `Document.Заказ`. */
export const ORDER_FILES: readonly string[] = [
  'Documents/Заказ.xml',
  'Documents/Заказ/Ext/ObjectModule.bsl',
  ...ORDER_FORM_FILES,
];

export const BOM = String.fromCharCode(0xfeff);

export function seedRootPart(emulator: AgentConfigEmulator): void {
  emulator.putFile(ROOT_PART_FILE, '<HomePageWorkArea/>');
}

export function removeRootPart(emulator: AgentConfigEmulator): void {
  emulator.removeFiles([ROOT_PART_FILE]);
}

/**
 * Документ `Заказ` с подобъектом-макетом: настоящая платформа после очистки владельца в CDI зеркала отдаёт
 * в `--get-changes` не только `New: <владелец>`, но и `New: <владелец>.<подобъект>` (ФАКТ П3b плана).
 */
export function seedOrderWithTemplate(emulator: AgentConfigEmulator, withSubObjectLines: boolean): void {
  emulator.setObject('Document.Заказ', {
    'Documents/Заказ.xml': '<Document>Заказ</Document>',
    'Documents/Заказ/Ext/ObjectModule.bsl': 'Процедура Заказ() КонецПроцедуры',
    'Documents/Заказ/Forms/Форма.xml': '<Form>Форма</Form>',
    'Documents/Заказ/Forms/Форма/Ext/Form.xml': '<FormBody/>',
    'Documents/Заказ/Templates/Макет.xml': '<Template>Макет</Template>',
    'Documents/Заказ/Templates/Макет/Ext/Template.xml': '<Макет/>',
  }, withSubObjectLines ? ['Template.Макет'] : []);
}

export type DumpKind = 'get-changes' | 'get-changes-retry' | 'info-only' | 'archive' | 'update' | 'list-file' | 'other';

/** Вид команды выгрузки: по ним проверяется порядок «список → CDI → повторный список → --update». */
export function dumpKindOf(command: ParsedAgentCommand): DumpKind {
  if (hasOption(command, 'get-changes')) {
    return String(command.options['get-changes']).endsWith('.changes-retry') ? 'get-changes-retry' : 'get-changes';
  }
  if (hasOption(command, 'config-dump-info-only')) {
    return 'info-only';
  }
  if (hasOption(command, 'archive')) {
    return 'archive';
  }
  if (hasOption(command, 'list-file')) {
    return 'list-file';
  }
  return command.options.update === true ? 'update' : 'other';
}

/** Виды команд выгрузки после точки `from` (индекс в журнале `emulator.commands`). */
export function dumpKindsFrom(emulator: AgentConfigEmulator, from: number): DumpKind[] {
  return emulator.commands
    .slice(from)
    .filter((command) => command.command === 'config dump-config-to-files')
    .map(dumpKindOf);
}

export function dumpsFrom(emulator: AgentConfigEmulator, from: number): ParsedAgentCommand[] {
  return emulator.commands.slice(from).filter((command) => command.command === 'config dump-config-to-files');
}

export interface AvoidStartOptions {
  readonly coverage: SyncMirrorCoverage;
  readonly kind?: HarnessKind;
  readonly targetKind?: HarnessTargetKind;
  readonly harness?: HarnessOptions;
  /** Дополнительное наполнение «базы» ДО первого импорта (часть корня, макет и т.п.). */
  readonly seed?: (emulator: AgentConfigEmulator) => void;
}

/**
 * Стенд: «база» (STANDARD_DB + `seed`), первый импорт (архив: M самозасеян → `sparse`), для `full` — M
 * заменяется полной выгрузкой. Эмулятор — в режиме `changed-files`, как настоящий агент.
 */
export async function startAvoidHarness(options: AvoidStartOptions): Promise<SyncHarness> {
  const targetKind = options.targetKind ?? 'cf';
  const h = await createHarness(options.kind ?? 'sftp', { ...options.harness, targetKind });
  h.seedDb();
  options.seed?.(h.emulator);
  h.emulator.setConfiguration(targetKind === 'cf' ? 'Основная' : HARNESS_EXTENSION_NAME, targetKind);
  h.emulator.updateGranularity = 'changed-files';
  await h.importTarget();
  assert.strictEqual(h.manifest().mirrorCoverage, 'sparse', 'сценарий: самопосев из архива даёт разреженный M');
  if (options.coverage === 'full') {
    h.makeMirrorFull();
    assert.strictEqual(h.manifest().mirrorCoverage, 'full');
  }
  return h;
}

export function targetNameOf(kind: HarnessTargetKind): string {
  return kind === 'cf' ? 'Основная' : HARNESS_EXTENSION_NAME;
}

/** Файловое содержимое M в виде base64 по пути: сравнение с `dbFiles()` побайтно. */
export function dbAsBase64(files: Record<string, Buffer>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([rel, data]) => [rel, data.toString('base64')]));
}

/**
 * «ОБЩЕЕ» из §6 плана: P ≡ БД (без файла версий, дельта его не пишет), манифест `fresh` с прежней полнотой и
 * `files = buildSyncManifestFiles(P)`, архива полной выгрузки (`full.zip`) после `from` нет, остатков обмена нет.
 */
export async function assertCommon(h: SyncHarness, from: number, coverage: SyncMirrorCoverage): Promise<void> {
  const actual = h.snapshotP();
  delete actual['ConfigDumpInfo.xml'];
  assert.deepStrictEqual(actual, dbAsText(h.emulator.dbTrackedFiles()), 'P ≡ БД');
  assert.strictEqual(h.manifest().mirrorState, 'fresh');
  assert.strictEqual(h.manifest().mirrorCoverage, coverage);
  assert.deepStrictEqual(h.manifest().files, await buildSyncManifestFiles(h.configRoot));
  assert.ok(
    !dumpsFrom(h.emulator, from).some((d) => d.options.archive === 'full.zip'),
    'архив полной выгрузки не запрашивался'
  );
  assert.deepStrictEqual(h.serverExchangeLeftovers(), [], 'остатки обмена на сервере');
  assert.deepStrictEqual(h.localExchangeLeftovers(), [], 'остатки обмена локально');
}

/** M (полный) побайтно ≡ выгрузке базы, включая файл версий. */
export function assertMirrorEqualsDb(h: SyncHarness): void {
  assert.deepStrictEqual(h.snapshotM(), dbAsBase64(h.emulator.dbFiles()), 'M ≡ БД побайтно');
}

/** Разреженный M: файла версий M ≡ файлу версий БД и нет ни одного файла перечисленных путей. */
export function assertSparseMirrorWithoutFiles(h: SyncHarness, rels: readonly string[]): void {
  const listed = h.listM();
  for (const rel of rels) {
    assert.ok(!listed.includes(rel), `в M нет ${rel}`);
  }
  assert.strictEqual(
    h.readM('ConfigDumpInfo.xml'),
    h.emulator.dbFiles()['ConfigDumpInfo.xml'].toString('utf-8'),
    'CDI M ≡ CDI БД'
  );
}

/**
 * Вырезает владельца (блок записей) из текста файла версий эмулятора: от строки открывающего тега до строки
 * `  </Metadata>` либо одну самозакрытую строку. Нужен там, где тест подкладывает «свежий CDI без живого владельца».
 */
export function cutOwnerFromCdiText(text: string, owner: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(`name="${owner}"`));
  assert.ok(start >= 0, `в CDI есть ${owner}`);
  const end = lines[start].trimEnd().endsWith('/>')
    ? start
    : lines.findIndex((line, index) => index > start && line === '  </Metadata>');
  assert.ok(end >= start, `блок ${owner} закрыт`);
  lines.splice(start, end - start + 1);
  return lines.join('\n');
}

/** Снимок всего, что операция обязана не тронуть при отказе до мутаций: M, P и файл манифеста побайтно. */
export interface UntouchedSnapshot {
  readonly m: Record<string, string>;
  readonly p: Record<string, string>;
  readonly manifest: string | undefined;
}

export function snapshotUntouched(h: SyncHarness): UntouchedSnapshot {
  return { m: h.snapshotM(), p: h.snapshotP(), manifest: h.rawManifestText() };
}

export function assertUntouched(h: SyncHarness, before: UntouchedSnapshot): void {
  assert.deepStrictEqual(h.snapshotM(), before.m, 'M побайтно прежний');
  assert.deepStrictEqual(h.snapshotP(), before.p, 'P не тронут');
  assert.strictEqual(h.rawManifestText(), before.manifest, 'файл манифеста побайтно прежний');
}
