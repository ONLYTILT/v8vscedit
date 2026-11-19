import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import { AgentCommandError } from '../AgentTransport';
import { parseConfigDumpInfoIndex, type ConfigDumpInfoIndex } from '../../xml/dumpInfo/ConfigDumpInfoIndex';
import { ArchiveFormatError, openArchive } from './ArchiveCodec';
import { openFileByteSource } from './ArchiveFile';
import { CONFIG_DUMP_INFO_XML } from './ProjectFiles';
import {
  EXCHANGE_DUMP_INFO_ARCHIVE,
  EXCHANGE_DUMP_INFO_DIR,
  exchangeDirOf,
  throwIfCancelled,
  withTransferCancellation,
  type SyncOperationContext,
} from './SyncContext';

/**
 * Свежий файл версий базы без выгрузки конфигурации: `dump --config-dump-info-only --archive=cdi.zip`
 * в отдельный каталог обмена (Э19, §5b п.9 — zip в разы меньше XML). M не трогается: решение, что в нём
 * чистить, принимается по сравнению с этим файлом ДО любой мутации.
 *
 * `{ ok: false }` — свежего файла версий нет или ему нельзя верить (отказ агента, испорченный архив,
 * страж Р6): вызывающий уходит в запасной путь. Транспорт и отмена — исключения: повтор запасным
 * путём их не лечит.
 */
export type FreshDumpInfoResult =
  | { readonly ok: true; readonly index: ConfigDumpInfoIndex }
  | { readonly ok: false; readonly reason: string };

const HIERARCHICAL = 'Hierarchical';

export async function fetchFreshDumpInfo(
  context: SyncOperationContext,
  mirrorIndex: ConfigDumpInfoIndex
): Promise<FreshDumpInfoResult> {
  const dir = `${exchangeDirOf(context)}/${EXCHANGE_DUMP_INFO_DIR}`;
  try {
    await context.exec.execute(buildDumpConfigToFilesCommand(dir, {
      extensionName: context.extensionName,
      configDumpInfoOnly: true,
      archive: EXCHANGE_DUMP_INFO_ARCHIVE,
      // Как в пилоте Э19b: выгрузка в пустой каталог обмена с --force.
      force: true,
    }));
  } catch (error) {
    if (error instanceof AgentCommandError) {
      return { ok: false, reason: `агент не выгрузил файл версий: ${oneLine(error.message)}` };
    }
    throw error;
  }
  throwIfCancelled(context);
  const zipPath = await context.localExchange.file(EXCHANGE_DUMP_INFO_ARCHIVE);
  const cancellation = context.hooks?.cancellation;
  await withTransferCancellation(() => context.store.downloadToFile(`${dir}/${EXCHANGE_DUMP_INFO_ARCHIVE}`, zipPath, { cancellation }));
  // Каталог больше не нужен при любом исходе разбора; остаток убрал бы и движок вместе с каталогом обмена.
  await context.store.remove(dir, { recursive: true });

  let text: string;
  try {
    text = await readDumpInfoFromArchive(zipPath);
  } catch (error) {
    if (error instanceof ArchiveFormatError) {
      return { ok: false, reason: `архив файла версий испорчен: ${oneLine(error.message)}` };
    }
    /* c8 ignore start -- кроме ArchiveFormatError разбор локального файла отказывает только при сбое
       диска (файл только что скачан в каталог обмена операции); из тестов недостижимо. */
    throw error;
  }
  /* c8 ignore stop */
  const index = parseConfigDumpInfoIndex(text);
  const rejection = guardFreshDumpInfo(index, mirrorIndex);
  return rejection === undefined ? { ok: true, index } : { ok: false, reason: rejection };
}

/**
 * Страж Р6: свежий файл версий сравнивается с файлом версий M, только если описывает ту же конфигурацию в
 * том же формате. Иначе «пропавшие» записи — артефакт сравнения несравнимого, и очистка по ним снесла бы
 * живые объекты.
 */
function guardFreshDumpInfo(fresh: ConfigDumpInfoIndex, mirror: ConfigDumpInfoIndex): string | undefined {
  const header = fresh.header;
  if (header === undefined) {
    return 'свежий файл версий не разобран: нет корня ConfigDumpInfo с форматом и версией';
  }
  if (header.format !== HIERARCHICAL) {
    return `свежий файл версий не иерархической выгрузки (формат «${header.format}»)`;
  }
  const mirrorVersion = mirror.header?.version;
  if (header.version !== mirrorVersion) {
    return `версия формата свежего файла версий (${header.version}) не совпадает с зеркалом (${String(mirrorVersion)})`;
  }
  if (fresh.configurationOwner !== mirror.configurationOwner) {
    return `корень конфигурации свежего файла версий (${String(fresh.configurationOwner)}) не совпадает с зеркалом (${String(mirror.configurationOwner)})`;
  }
  return undefined;
}

/**
 * Одна запись в десятки мегабайт держится в памяти целиком — как при посеве M из архива
 * (`seedMirrorFromArchive`): разбор индекса всё равно работает по тексту.
 */
async function readDumpInfoFromArchive(zipPath: string): Promise<string> {
  const source = await openFileByteSource(zipPath);
  try {
    const reader = await openArchive(source);
    let text = '';
    await reader.read(new Set([CONFIG_DUMP_INFO_XML]), (entry) => {
      text = Buffer.from(entry.data).toString('utf-8');
    });
    return text;
  } finally {
    await source.close();
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
