import type { DumpChangedObject } from '../../../domain/agent/DumpChangesParser';
import { META_TYPES, type MetaTypeDef } from '../../../domain/MetaTypes';
import type { AgentFileStore } from '../files/AgentFileStore';

/**
 * Перевод строк `--get-changes` в файлы выгрузки. Гранулярность — владелец верхнего уровня
 * (`<EnglishKind>.<Name>` → `<Folder>/<Name>.xml` + поддерево `<Folder>/<Name>/`), как велит пилот
 * (§5b п.10): точное сопоставление частей (`Form.X.Form` → два файла и т.п.) — оптимизация, а цена
 * ошибки в нём — молча пропущенный файл.
 *
 * Вид → папка выводится из META_TYPES, а не из собственного словаря: новый вид метаданных
 * подхватывается одной записью в реестре (CLAUDE.md, запрет №2).
 */

export interface ChangedOwner {
  /** `<EnglishKind>.<Name>`. */
  readonly fullName: string;
  readonly kind: string;
  readonly name: string;
  /** XML владельца относительно каталога выгрузки. */
  readonly xmlRel: string;
  /** Поддерево владельца; у корня конфигурации — только `Ext/` (модули и интерфейс), не вся выгрузка. */
  readonly dirRel: string;
}

export interface ChangedOwnersResult {
  readonly owners: ChangedOwner[];
  /** Строки, вид которых не переводится в папку (неизвестный, дочерний, расширение). */
  readonly unresolved: string[];
}

export interface OwnerFilesResult {
  /** Файлы владельцев относительно каталога цели. */
  readonly files: string[];
  /** Владельцы, которых нет в M ни XML, ни каталогом. */
  readonly missingOwners: ChangedOwner[];
}

const CONFIGURATION_KIND = META_TYPES.configuration.englishKind;
const CONFIGURATION_XML = 'Configuration.xml';
/**
 * Части корня (`SessionModule`, `ManagedApplicationModule`, `CommandInterface`, `HomePageWorkArea`,
 * `ClientApplicationInterface`, …) лежат в `Ext/`: без него изменение модуля конфигурации не
 * скачивалось бы, и P молча расходился с базой.
 */
const CONFIGURATION_DIR = 'Ext';

/**
 * Карта «английский вид из `--get-changes` → папка выгрузки». Отдельной функцией, потому что
 * в текущем реестре у всех видов с папкой `englishKind` задан явно, а контракт `META_TYPES`
 * допускает его отсутствие (тогда он равен `kind`) — этот фолбэк проверяется на синтетической записи.
 */
export function buildFolderByEnglishKind(defs: readonly MetaTypeDef[]): ReadonlyMap<string, string> {
  return new Map(
    defs
      .filter((def): def is MetaTypeDef & { readonly folder: string } => def.folder !== undefined)
      .map((def) => [def.englishKind ?? def.kind, def.folder] as const)
  );
}

const FOLDER_BY_ENGLISH_KIND = buildFolderByEnglishKind(Object.values(META_TYPES));

export function resolveChangedOwners(changes: readonly DumpChangedObject[]): ChangedOwnersResult {
  const owners = new Map<string, ChangedOwner>();
  const unresolved: string[] = [];
  for (const change of changes) {
    const fullName = `${change.kind}.${change.name}`;
    if (owners.has(fullName)) {
      continue;
    }
    if (change.kind === CONFIGURATION_KIND) {
      owners.set(fullName, { fullName, kind: change.kind, name: change.name, xmlRel: CONFIGURATION_XML, dirRel: CONFIGURATION_DIR });
      continue;
    }
    const folder = FOLDER_BY_ENGLISH_KIND.get(change.kind);
    if (folder === undefined) {
      unresolved.push(change.fullName);
      continue;
    }
    owners.set(fullName, {
      fullName,
      kind: change.kind,
      name: change.name,
      xmlRel: `${folder}/${change.name}.xml`,
      dirRel: `${folder}/${change.name}`,
    });
  }
  return { owners: [...owners.values()], unresolved };
}

/** Файлы владельцев в M (каталог цели `targetRel` в хранилище агента). */
export async function collectOwnerFiles(
  store: AgentFileStore,
  targetRel: string,
  owners: readonly ChangedOwner[]
): Promise<OwnerFilesResult> {
  const files: string[] = [];
  const missingOwners: ChangedOwner[] = [];
  const prefix = targetRel ? `${targetRel}/` : '';
  for (const owner of owners) {
    let found = false;
    const xml = await store.stat(prefix + owner.xmlRel);
    if (xml?.type === 'file') {
      files.push(owner.xmlRel);
      found = true;
    }
    const dir = await store.stat(prefix + owner.dirRel);
    if (dir?.type === 'dir') {
      found = true;
      for (const entry of await store.list(prefix + owner.dirRel, { recursive: true })) {
        if (entry.type === 'file') {
          files.push(entry.path.slice(prefix.length));
        }
      }
    }
    if (!found) {
      missingOwners.push(owner);
    }
  }
  return { files, missingOwners };
}
