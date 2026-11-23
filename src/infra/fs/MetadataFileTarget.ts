import * as path from 'path';
import type { ChildTag } from '../../domain/ChildTag';
import type { MetaKind } from '../../domain/MetaTypes';
import { resolveFilePart, type MetadataChangePart } from '../git/MetadataChangeResolver';

/** Дочерние узлы объекта, у которых есть собственные файлы выгрузки. */
export type MetadataFileChildKind = Extract<ChildTag, 'Form' | 'Template' | 'Command'>;

/**
 * Куда в дереве метаданных ведёт файл выгрузки. Без `object` — корень конфигурации
 * или расширения (`Configuration.xml`, модули приложения/сеанса из `Ext/`).
 */
export interface MetadataFileTarget {
  readonly configRoot: string;
  readonly object?: {
    readonly kind: MetaKind;
    /** Имя объекта; у вложенной подсистемы — цепочка от верхней подсистемы к вложенной. */
    readonly names: readonly string[];
    readonly child?: { readonly kind: MetadataFileChildKind; readonly name: string };
  };
}

const CHILD_FOLDERS: ReadonlyMap<string, MetadataFileChildKind> = new Map([
  ['Forms', 'Form'],
  ['Templates', 'Template'],
  ['Commands', 'Command'],
]);

/**
 * Разбирает абсолютный путь файла в цель навигатора. Работает только со строкой пути
 * (ФС не читает): вызывается на каждую смену активного редактора ради признака
 * контекста горячей клавиши. `null` — файл не относится к метаданным загруженных корней.
 */
export function resolveMetadataFileTarget(configRoots: readonly string[], filePath: string): MetadataFileTarget | null {
  const located = locateRoot(configRoots, filePath);
  if (!located) {
    return null;
  }
  const { configRoot, segments } = located;
  if (segments.length === 0) {
    return null;
  }
  if ((segments.length === 1 && segments[0] === 'Configuration.xml') || segments[0] === 'Ext') {
    return { configRoot };
  }

  const part = resolveFilePart(configRoot, path.join(configRoot, ...segments));
  if (!part) {
    return null;
  }
  return { configRoot, object: toObjectTarget(part, segments.slice(2)) };
}

/** Признак для `when` горячей клавиши: есть ли у файла узел в дереве. */
export function isMetadataFile(configRoots: readonly string[], filePath: string): boolean {
  return resolveMetadataFileTarget(configRoots, filePath) !== null;
}

/**
 * Корень с самым длинным префиксом — на случай вложенных корней. Сравнение без учёта
 * регистра: путь из редактора приходит с буквой диска в нижнем регистре (`c:\…`),
 * а корни выгрузки — как их нашёл `ConfigLocator`.
 */
function locateRoot(
  configRoots: readonly string[],
  filePath: string
): { configRoot: string; segments: string[] } | null {
  const file = path.resolve(filePath);
  const fileKey = file.toLowerCase();
  let best: { configRoot: string; rootLength: number } | null = null;
  for (const configRoot of configRoots) {
    const rootKey = path.resolve(configRoot).toLowerCase();
    const insideRoot = fileKey === rootKey || fileKey.startsWith(rootKey + path.sep);
    if (insideRoot && (!best || rootKey.length > best.rootLength)) {
      best = { configRoot, rootLength: rootKey.length };
    }
  }
  if (!best) {
    return null;
  }
  return { configRoot: best.configRoot, segments: file.slice(best.rootLength).split(/[\\/]/).filter(Boolean) };
}

/**
 * `rest` — сегменты пути внутри каталога объекта (после `<Папка>/<Имя>`). Резолвер изменений
 * задаёт `childName` ровно у формы, макета и модулей формы/команды.
 */
function toObjectTarget(part: MetadataChangePart, rest: readonly string[]): NonNullable<MetadataFileTarget['object']> {
  const object = { kind: part.rootKind, names: [part.rootName] };
  if (part.childName !== undefined) {
    const kind: MetadataFileChildKind = part.part === 'template' ? 'Template' : part.slot === 'ChildCommand' ? 'Command' : 'Form';
    return { ...object, child: { kind, name: part.childName } };
  }
  if (part.part !== 'raw') {
    return object;
  }

  // «Прочее» резолвера изменений: дескрипторы форм/макетов (`Forms/<Имя>.xml`), содержимое
  // макета кроме Template.xml и вложенные подсистемы — для навигатора у них есть свои узлы.
  if (part.rootKind === 'Subsystem') {
    return { ...object, names: [part.rootName, ...nestedSubsystemNames(rest)] };
  }
  const childKind = CHILD_FOLDERS.get(rest[0]);
  if (childKind && rest[1]) {
    return { ...object, child: { kind: childKind, name: stripXml(rest[1]) } };
  }
  return object;
}

function nestedSubsystemNames(rest: readonly string[]): string[] {
  const names: string[] = [];
  for (let index = 0; rest[index] === 'Subsystems' && rest[index + 1]; index += 2) {
    names.push(stripXml(rest[index + 1]));
  }
  return names;
}

function stripXml(segment: string): string {
  return segment.replace(/\.xml$/i, '');
}
