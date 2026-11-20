import type { DumpChangedObject } from '../../../domain/agent/DumpChangesParser';
import { META_TYPES } from '../../../domain/MetaTypes';
import { PARENT_CONFIGURATIONS_DIR_REL, PARENT_CONFIGURATIONS_PART } from '../../support/SupportFiles';

/**
 * Шлюз конфигурации поставщика при импорте дельтой (plan-large-files.md §1, ФАКТЫ Э26/Э27). Файлы
 * `Ext/ParentConfigurations/**` весят до гигабайта, а расширению не нужны вовсе (их читает только платформа при
 * загрузке). `--update` корня переписывает их в M при ЛЮБОЙ правке корня, и отбор по времени изменения их не
 * отсекает — поэтому они скачиваются только при доказанном изменении части `ParentConfigurations`.
 *
 * Безопасность не держится на одном списке изменений агента: `Ext/ParentConfigurations.bin` (мегабайты) НЕ
 * шлюзуется и служит страховкой — обновление поставщика всегда меняет его (в нём версия поставщика), и
 * изменившийся `.bin` снимает шлюз. Плюс самовосстановление: файла нет в P или размер в P ≠ M — скачивание.
 *
 * Это не словарь видов метаданных, а политика синхронизации по частям корня: вид корня берётся из `META_TYPES`.
 * Чистый модуль: без ФС и vscode.
 */

/**
 * Выключатель шлюза. Полный Э27 локально не снят (пакетно поставить базу на поддержку нельзя), шлюз включён
 * решением оркестратора: его страхуют `.bin` и размеры. Если стенд опровергнет допущение — выключается здесь.
 */
export const VENDOR_CONFIGURATION_GATE_ENABLED = true;

/** Что известно об изменённых частях корня в этой операции. */
export type RootPartEvidence =
  | { readonly kind: 'known'; readonly changedParts: ReadonlySet<string> }
  | { readonly kind: 'unknown'; readonly reason: string };

/* c8 ignore next -- у корня englishKind задан всегда; запасной kind — общий шаблон чтения META_TYPES. */
const ROOT_KIND = META_TYPES.configuration.englishKind ?? META_TYPES.configuration.kind;
const VENDOR_DIR_PREFIX = `${PARENT_CONFIGURATIONS_DIR_REL}/`;

/**
 * По строкам `--get-changes` (грамматика §5b п.8). `New: Configuration.X` — корень выгружается целиком после
 * очистки, частей не перечислить: доказательства нет. Строки других видов на корень не влияют.
 */
export function evidenceFromChangeObjects(objects: readonly DumpChangedObject[]): RootPartEvidence {
  const changedParts = new Set<string>();
  for (const object of objects) {
    if (object.kind !== ROOT_KIND) {
      continue;
    }
    if (object.parts.length === 0) {
      if (object.change === 'added') {
        return { kind: 'unknown', reason: `корень конфигурации выгружается целиком (New: ${object.fullName})` };
      }
      continue;
    }
    changedParts.add(object.parts[0]);
  }
  return { kind: 'known', changedParts };
}

/**
 * По сравнению файлов версий (перезапись M при FullDump): имена файловых записей added ∪ modified. Запись
 * корня в modified — норма (версия владельца растёт вместе с частью); в added — корня не было в сравниваемом
 * файле версий, части не перечислить.
 */
export function evidenceFromDumpInfoNames(diff: { readonly added: readonly string[]; readonly modified: readonly string[] }): RootPartEvidence {
  const changedParts = new Set<string>();
  const rootPrefix = `${ROOT_KIND}.`;
  for (const [names, added] of [[diff.added, true], [diff.modified, false]] as const) {
    for (const name of names) {
      if (!name.startsWith(rootPrefix)) {
        continue;
      }
      const segments = name.split('.');
      if (segments.length <= 2) {
        if (added) {
          return { kind: 'unknown', reason: `корня конфигурации не было в файле версий зеркала (${name})` };
        }
        continue;
      }
      changedParts.add(segments[2]);
    }
  }
  return { kind: 'known', changedParts };
}

/** Шлюзуемый файл: внутри каталога поставщиков, регистр точный (ошибка регистра ведёт к скачиванию, а не к пропуску). */
export function isVendorConfigurationFile(rel: string): boolean {
  return rel.startsWith(VENDOR_DIR_PREFIX) && rel.length > VENDOR_DIR_PREFIX.length;
}

/**
 * Шлюз применяется к файлу: он шлюзуемый и шлюз включён. Единственная точка, читающая выключатель: при
 * выключенном шлюзе файл поставщика идёт по обычным правилам дельты (в том числе «вне B — скачивать»).
 */
export function isVendorGated(rel: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- выключатель меняется правкой константы
  return VENDOR_CONFIGURATION_GATE_ENABLED && isVendorConfigurationFile(rel);
}

export interface VendorDownloadInput {
  readonly rel: string;
  /**
   * Скачивается всегда: грязный относительно B или совпадает с удаляемым без учёта регистра. «Вне B» сюда НЕ
   * входит: `.cf` не отслеживается манифестом B никогда, иначе шлюз не срабатывал бы вовсе. Цена принята
   * осознанно: локальная правка `.cf` того же размера не обнаруживается — файл генерирует платформа и руками не
   * правится, а страхуют отсутствие в P, расхождение размера P ≠ M и изменение `.bin`.
   */
  readonly mustFetch: boolean;
  readonly evidence: RootPartEvidence | undefined;
  /** `.bin` скачан и отличается от P (или его нет в P), либо пропал из M. */
  readonly binChanged: boolean;
  /** Размер в P; `undefined` — файла в P нет. */
  readonly projectSize: number | undefined;
  /** Размер в M из LIST/STAT; `undefined` — неизвестен. */
  readonly mirrorSize: number | undefined;
}

/** Порядок проверок — §1.3 плана; любая неопределённость — скачивание. */
export function decideVendorDownload(input: VendorDownloadInput): 'download' | 'skip' {
  const { evidence } = input;
  if (!isVendorGated(input.rel) || input.mustFetch) {
    return 'download';
  }
  if (evidence === undefined || evidence.kind === 'unknown' || evidence.changedParts.has(PARENT_CONFIGURATIONS_PART)) {
    return 'download';
  }
  if (input.binChanged || input.projectSize === undefined || input.mirrorSize === undefined) {
    return 'download';
  }
  return input.projectSize === input.mirrorSize ? 'skip' : 'download';
}
