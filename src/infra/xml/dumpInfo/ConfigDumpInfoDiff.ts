import { CONFIGURATION_PREFIX, dumpInfoOwnerOf, type ConfigDumpInfoIndex } from './ConfigDumpInfoIndex';

/**
 * Сравнение двух файлов версий выгрузки (зеркало агента ↔ свежий файл версий базы; зеркало до и после
 * перезаписи). Версии сравниваются по файловым записям (с `configVersion`): изменение встроенной записи
 * (реквизит, ТЧ) видно по версии её владельца. Но ПРОПАЖА встроенной записи (удалённый или
 * переименованный реквизит) — тоже причина FullDump агента и по версиям не видна: такие записи
 * сравниваются по именам (`removedEmbedded`), а их владелец чистится целиком, как владелец с
 * удалённой формой.
 *
 * Чистые функции: решение «что чистить в зеркале» принимает планировщик, а файлы трогает движок.
 */

export interface DumpInfoDiff {
  readonly added: string[];
  readonly removed: string[];
  readonly modified: string[];
  /** Встроенные записи (без `configVersion`), которых нет в `after` ни встроенными, ни файловыми. */
  readonly removedEmbedded: string[];
}

export interface DumpInfoOwnerChange {
  readonly fullName: string;
  readonly change: 'added' | 'modified';
}

export interface DumpInfoOwnerChanges {
  /** Владельцев больше нет в `after`: удалённые объекты и старые имена переименованных. Корня здесь нет никогда. */
  readonly removedOwners: readonly string[];
  /** Живые владельцы, у которых пропала хотя бы одна запись: файловая (форма, макет, модуль) или встроенная (реквизит, ТЧ). */
  readonly ownersWithRemovedParts: readonly string[];
  /** Владельцы с добавленными или изменёнными записями; `added` — владельца не было в `before`. */
  readonly changedOwners: readonly DumpInfoOwnerChange[];
  /** В `after` нет корня `Configuration.*`: такой файл версий не описывает выгрузку конфигурации. */
  readonly configurationMissing: boolean;
}

export function diffConfigDumpInfo(before: ConfigDumpInfoIndex, after: ConfigDumpInfoIndex): DumpInfoDiff {
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [name, version] of before.fileLevelVersions) {
    const now = after.fileLevelVersions.get(name);
    if (now === undefined) {
      removed.push(name);
    } else if (now !== version) {
      modified.push(name);
    }
  }
  const added = [...after.fileLevelVersions.keys()].filter((name) => !before.fileLevelVersions.has(name));
  // Встроенная запись, ставшая файловой (у реквизита не бывает, но формат это допускает), не пропала.
  const removedEmbedded = [...before.embeddedNames].filter(
    (name) => !after.embeddedNames.has(name) && !after.fileLevelVersions.has(name)
  );
  // Порядок записей в файле не должен влиять на решения и сообщения: результат сортируется.
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort(), removedEmbedded: removedEmbedded.sort() };
}

export function groupDumpInfoDiffByOwner(
  diff: DumpInfoDiff,
  before: ConfigDumpInfoIndex,
  after: ConfigDumpInfoIndex
): DumpInfoOwnerChanges {
  const afterOwners = ownersOf(after);
  const removedOwners = new Set<string>();
  const ownersWithRemovedParts = new Set<string>();
  for (const name of [...diff.removed, ...diff.removedEmbedded]) {
    const owner = dumpInfoOwnerOf(name);
    if (afterOwners.has(owner)) {
      ownersWithRemovedParts.add(owner);
    } else if (!owner.startsWith(CONFIGURATION_PREFIX)) {
      // Пропавший корень — не «удалённый владелец», а непригодный файл версий (`configurationMissing`).
      removedOwners.add(owner);
    }
  }
  const changed = [...new Set([...diff.added, ...diff.modified].map(dumpInfoOwnerOf))].sort();
  return {
    removedOwners: [...removedOwners].sort(),
    ownersWithRemovedParts: [...ownersWithRemovedParts].sort(),
    changedOwners: changed.map((fullName) => ({
      fullName,
      change: before.rootNames.has(fullName) ? 'modified' : 'added',
    })),
    configurationMissing: after.configurationOwner === undefined,
  };
}

/** Владельцы файла версий: корневые записи и владельцы файловых записей (на случай записи без корня). */
function ownersOf(index: ConfigDumpInfoIndex): ReadonlySet<string> {
  return new Set([...index.rootNames, ...[...index.fileLevelVersions.keys()].map(dumpInfoOwnerOf)]);
}
