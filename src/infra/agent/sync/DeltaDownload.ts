import { PARENT_CONFIGURATIONS_BIN_REL } from '../../support/SupportFiles';
import { downloadDeltaLanes, type DeltaFile } from './DeltaLanes';
import { projectFileSize } from './ProjectFiles';
import { summarizeList } from './ProjectSeed';
import type { SyncOperationContext } from './SyncContext';
import { formatByteSize, formatFileCount } from './TransferProgressText';
import { decideVendorDownload, isVendorGated, type RootPartEvidence } from './VendorConfigurationGate';

/**
 * Скачивание дельты импорта (plan-large-files.md §1.4, §2.3, §3.2): файлы, отобранные планом и отбором по времени
 * изменения, — через две полосы (`DeltaLanes`); поверх — шлюз конфигурации поставщика и заблаговременные строки
 * журнала (сколько и сколько весит, какие файлы большие).
 *
 * Порядок: сначала всё, кроме файлов поставщика, которые шлюз пропускает, — включая страхующий `.bin`; затем по
 * итогу `.bin` решается судьба пропущенных: `.bin` изменился — они докачиваются, иначе пропуск в журнал.
 */

export interface VendorGateInput {
  readonly evidence: RootPartEvidence | undefined;
  /** Грязный относительно B или совпадает с удаляемым без учёта регистра (см. `VendorDownloadInput.mustFetch`). */
  readonly mustFetch: (rel: string) => boolean;
  /** `.bin` пропал из M при наличии файлов поставщика — набор поставщиков изменился. */
  readonly binDeleted: boolean;
}

export interface DeltaDownloadInput {
  readonly files: readonly DeltaFile[];
  readonly sameFileAsDeleted: (rel: string) => boolean;
  readonly gate: VendorGateInput;
}

export interface DeltaDownloadResult {
  /** Отличающиеся от P файлы: путь в P → staging (порядок — порядок завершения скачивания). */
  readonly staged: ReadonlyMap<string, string>;
  /** Файлы поставщика, пропущенные шлюзом. */
  readonly skippedVendor: readonly string[];
}

const WARN_SHOWN = 3;
const SKIPPED_SHOWN = 3;

export async function downloadDelta(context: SyncOperationContext, input: DeltaDownloadInput): Promise<DeltaDownloadResult> {
  const { gate } = input;
  const projectDir = context.target.rootPath;
  const staged = new Map<string, string>();
  let stagingCount = 0;
  const lanes = (files: readonly DeltaFile[], title: string): Promise<void> => downloadDeltaLanes(context, {
    files,
    title,
    sameFileAsDeleted: input.sameFileAsDeleted,
    staged,
    nextStagingName: () => {
      stagingCount += 1;
      return `delta-${String(stagingCount)}`;
    },
  });
  const decide = (file: DeltaFile, binChanged: boolean): 'download' | 'skip' => decideVendorDownload({
    rel: file.rel,
    mustFetch: gate.mustFetch(file.rel),
    evidence: gate.evidence,
    binChanged,
    projectSize: projectFileSize(projectDir, file.rel),
    mirrorSize: file.size,
  });

  const gated = input.files.filter((file) => isVendorGated(file.rel));
  if (gated.length > 0) {
    reportRootParts(context, gate.evidence);
  }
  // Пока `.bin` не скачан, «изменился» неизвестно: пропуск предварительный, его снимает страховка ниже.
  const deferred = new Set(gated.filter((file) => decide(file, false) === 'skip'));
  const first = input.files.filter((file) => !deferred.has(file));
  announce(context, `Скачивается ${describeSet(first)}.`, first);
  await lanes(first, 'Скачивание изменённых файлов');
  if (deferred.size === 0) {
    return { staged, skippedVendor: [] };
  }

  const rest = [...deferred];
  if (gate.binDeleted || staged.has(PARENT_CONFIGURATIONS_BIN_REL)) {
    announce(
      context,
      'Список изменений агента не упоминает конфигурацию поставщика, но ParentConfigurations.bin изменился — файлы ' +
      `поставщика скачиваются: ${describeSet(rest)}.`,
      rest
    );
    await lanes(rest, 'Скачивание файлов поставщика');
    return { staged, skippedVendor: [] };
  }
  context.progress.step(
    `Конфигурация поставщика не изменилась (по списку изменений агента): пропущено файлов — ${String(rest.length)}, ` +
    `${formatByteSize(sumSizes(rest))} (${summarizeList(rest.map((file) => file.rel), SKIPPED_SHOWN, ', ')}).`
  );
  return { staged, skippedVendor: rest.map((file) => file.rel) };
}

/** Диагностика стенда: какие части корня назвал агент (решение шлюза опирается на этот набор). */
function reportRootParts(context: SyncOperationContext, evidence: RootPartEvidence | undefined): void {
  if (evidence?.kind === 'known' && evidence.changedParts.size > 0) {
    context.progress.step(`Части корня в списке изменений: ${[...evidence.changedParts].sort().join(', ')}`);
  }
}

/** Итог набора и большие файлы — до первой передачи: долгая операция не должна выглядеть зависшей. */
function announce(context: SyncOperationContext, headline: string, files: readonly DeltaFile[]): void {
  if (files.length === 0) {
    return;
  }
  context.progress.step(headline);
  const big = files.filter((file) => file.size !== undefined && file.size >= context.largeFileWarnBytes);
  for (const file of big.slice(0, WARN_SHOWN)) {
    context.progress.step(`Среди скачиваемых — файл ${formatByteSize(Number(file.size))}: ${file.rel}.`);
  }
  if (big.length > WARN_SHOWN) {
    const more = big.length - WARN_SHOWN;
    context.progress.step(
      `Среди скачиваемых — и ещё ${formatFileCount(more)} не меньше ${formatByteSize(context.largeFileWarnBytes)}.`
    );
  }
}

function describeSet(files: readonly DeltaFile[]): string {
  return `${formatFileCount(files.length)}, ${formatByteSize(sumSizes(files))}`;
}

/** Неизвестный размер (файлы точечной выгрузки) в сумму не входит: он учитывается по факту скачивания. */
function sumSizes(files: readonly DeltaFile[]): number {
  return files.reduce((total, file) => total + (file.size ?? 0), 0);
}
