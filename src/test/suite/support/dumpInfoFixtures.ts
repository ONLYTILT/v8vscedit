/**
 * Синтетические `ConfigDumpInfo.xml` для тестов редактора, сравнения и свежего CDI (plan-fulldump-avoid.md).
 * Раскладка — настоящего файла: BOM, `<ConfigVersions>`, тег владельца открывающий и содержит детей,
 * порядок атрибутов `name`, `id`, `configVersion`, отступы табуляцией.
 */
import { parseConfigDumpInfoIndex, type ConfigDumpInfoIndex } from '../../../infra/xml/dumpInfo/ConfigDumpInfoIndex';

export interface CdiChild {
  /** Полное имя записи: `Document.Д.Form.Ф`. */
  readonly name: string;
  /** Есть версия — запись файловая; нет — встроенная (реквизит, ТЧ). */
  readonly version?: string;
}

export interface CdiOwner {
  /** `<EnglishKind>.<Name>` — и для `Configuration.Имя`. */
  readonly name: string;
  readonly version?: string;
  readonly children?: readonly CdiChild[];
}

export interface CdiRenderOptions {
  readonly bom?: boolean;
  readonly eol?: '\n' | '\r\n';
  readonly formatVersion?: string;
  readonly format?: string;
  /** Единица отступа: настоящий файл — табуляция. */
  readonly indent?: string;
}

const ROOT_ATTRIBUTES = 'xmlns="http://v8.1c.ru/8.3/xcf/dumpinfo" xmlns:xs="http://www.w3.org/2001/XMLSchema"';

export function buildCdiText(owners: readonly CdiOwner[], options: CdiRenderOptions = {}): string {
  const { bom = true, eol = '\n', formatVersion = '2.20', format = 'Hierarchical', indent = '\t' } = options;
  const tag = (name: string, version: string | undefined, depth: number, close: '/>' | '>'): string =>
    `${indent.repeat(depth)}<Metadata name="${name}" id="id-${name}"${version === undefined ? '' : ` configVersion="${version}"`}${close}`;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<ConfigDumpInfo ${ROOT_ATTRIBUTES} format="${format}" version="${formatVersion}">`,
    `${indent}<ConfigVersions>`,
  ];
  for (const owner of owners) {
    const children = owner.children ?? [];
    if (children.length === 0) {
      lines.push(tag(owner.name, owner.version, 2, '/>'));
      continue;
    }
    lines.push(tag(owner.name, owner.version, 2, '>'));
    for (const child of children) {
      lines.push(tag(child.name, child.version, 3, '/>'));
    }
    lines.push(`${indent.repeat(2)}</Metadata>`);
  }
  lines.push(`${indent}</ConfigVersions>`, '</ConfigDumpInfo>', '');
  return (bom ? String.fromCharCode(0xfeff) : '') + lines.join(eol);
}

export function buildCdiIndex(owners: readonly CdiOwner[], options: CdiRenderOptions = {}): ConfigDumpInfoIndex {
  return parseConfigDumpInfoIndex(buildCdiText(owners, options));
}

/** Корень конфигурации — без него CDI свежей выгрузки не принимается стражем. */
export const ROOT_OWNER: CdiOwner = { name: 'Configuration.Конфигурация', version: 'r1' };

/** Типичный документ: реквизит (встроенный), модуль объекта и форма с телом. */
export function documentOwner(name: string, version = 'v1', extra: readonly CdiChild[] = []): CdiOwner {
  const full = `Document.${name}`;
  return {
    name: full,
    version,
    children: [
      { name: `${full}.Attribute.Реквизит` },
      { name: `${full}.ObjectModule`, version: `${version}-om` },
      { name: `${full}.Form.Ф`, version: `${version}-f` },
      { name: `${full}.Form.Ф.Form`, version: `${version}-fb` },
      ...extra,
    ],
  };
}

/** Содержимое индекса в сравнимом виде: корни и версии файловых записей. */
export function summarizeIndex(index: ConfigDumpInfoIndex): { rootNames: string[]; versions: [string, string][] } {
  return {
    rootNames: [...index.rootNames].sort(),
    versions: [...index.fileLevelVersions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}
