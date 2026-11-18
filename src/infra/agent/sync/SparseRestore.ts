import * as path from 'path';
import { buildDumpConfigToFilesCommand } from '../../../domain/agent/AgentCommand';
import { readConfigDumpInfoIndex } from '../../xml/dumpInfo/ConfigDumpInfoIndex';
import { AgentCommandError } from '../AgentTransport';
import { statFiles } from '../files/AgentFileTransfer';
import { ownerOfProjectFile } from './ChangedObjectFiles';
import { CONFIG_DUMP_INFO_XML } from './ProjectFiles';
import {
  EXCHANGE_RESTORE_DIR,
  EXCHANGE_RESTORE_LIST_SUFFIX,
  exchangeDirOf,
  throwIfCancelled,
  type SyncOperationContext,
} from './SyncContext';

/**
 * Точечная выгрузка из базы локально изменённых файлов, которых нет в разреженном M (план «полная
 * выгрузка — только когда без неё нельзя», §3.3, вариант А по эксперименту 12).
 *
 * Имена для `dump --list-file` берутся из файла версий ПРОЕКТА: «грязные» файлы, отсутствующие в
 * разреженном M, принадлежат подобъектам, не менявшимся в базе после посева, а посев шёл из этого же
 * файла версий (или из архива, который пишет его и в P). Перечисляется всё файловое поддерево владельца
 * (владелец + подобъекты с `configVersion`), а не точный подобъект файла: так не нужна вторая карта
 * «путь → имя»; лишние файлы выгружаются на сервере, но не скачиваются.
 *
 * Выгрузка идёт в каталог обмена `exchange/<op>/restore`, а не в M: M после шага такой же, как после
 * `--update`, полнота не меняется, `markMirrorMutated` не нужен. Любой отказ возвращается результатом —
 * движок уходит в архив `sparse-mirror-dirty`; P к этому моменту не тронут. Транспортные сбои и отмена —
 * исключения: это не «точечно нельзя», а «операция не удалась».
 */

export type SparseRestoreResult =
  | { readonly ok: true; readonly sourceDir: string }
  | { readonly ok: false; readonly reason: string };

const BOM = '﻿';
const LINE_BREAK = /[\r\n]/;

export async function restoreFromDatabase(context: SyncOperationContext, files: readonly string[]): Promise<SparseRestoreResult> {
  const names = await resolveListNames(context.target.rootPath, files);
  if (typeof names === 'string') {
    return refused(names);
  }

  const exchangeDir = exchangeDirOf(context);
  const sourceDir = `${exchangeDir}/${EXCHANGE_RESTORE_DIR}`;
  const listFile = `${exchangeDir}${EXCHANGE_RESTORE_LIST_SUFFIX}`;
  // Формат как у list-файла загрузки (пилот §5b п.11): UTF-8 с BOM, разделитель `\n`.
  await context.store.writeFile(listFile, `${BOM}${names.join('\n')}`);
  try {
    // Без `--update`: с `--list-file` агент его не принимает (эксперимент 11; guard — в домене).
    await context.exec.execute(buildDumpConfigToFilesCommand(sourceDir, {
      extensionName: context.extensionName,
      listFile,
      force: true,
    }));
  } catch (error) {
    if (error instanceof AgentCommandError) {
      return refused(error.message);
    }
    throw error;
  }
  throwIfCancelled(context);

  const stats = await statFiles(context.store, files.map((rel) => `${sourceDir}/${rel}`), {
    concurrency: context.transferConcurrency,
    cancellation: context.hooks?.cancellation,
  });
  throwIfCancelled(context);
  // Полноты поддерева не требуется — только нужные файлы; недовыгрузка любого из них молча оставила
  // бы P неверным.
  const missing = files.find((rel) => stats.get(`${sourceDir}/${rel}`)?.type !== 'file');
  return missing === undefined ? { ok: true, sourceDir } : refused(`точечная выгрузка не содержит ${missing}`);
}

/** Имена файловых записей CDI проекта для владельцев `files`, без повторов; строка — причина отказа. */
async function resolveListNames(projectDir: string, files: readonly string[]): Promise<string[] | string> {
  const owners = new Set<string>();
  let configuration = false;
  for (const rel of files) {
    const owner = ownerOfProjectFile(rel);
    if (owner === undefined) {
      return `файл вне известных папок выгрузки: ${rel}`;
    }
    if ('configuration' in owner) {
      configuration = true;
    } else {
      owners.add(owner.fullName);
    }
  }

  const index = await readConfigDumpInfoIndex(path.join(projectDir, CONFIG_DUMP_INFO_XML));
  if (index === undefined) {
    return `в выгрузке проекта нет разборчивого файла версий ${CONFIG_DUMP_INFO_XML}`;
  }
  const ownerNames: string[] = [];
  if (configuration) {
    if (index.configurationOwner === undefined) {
      return `в файле версий проекта нет корня конфигурации (Configuration.<Имя>)`;
    }
    ownerNames.push(index.configurationOwner);
  }
  ownerNames.push(...owners);

  const names = new Set<string>();
  for (const owner of ownerNames) {
    const ownerFileNames = index.fileLevelNamesOf(owner);
    if (ownerFileNames.length === 0) {
      return `объекта ${owner} нет в файле версий проекта`;
    }
    for (const name of ownerFileNames) {
      // Перевод строки в имени сломал бы формат списка: агент получил бы два чужих имени.
      if (LINE_BREAK.test(name)) {
        return `имя объекта с переводом строки в файле версий проекта: ${JSON.stringify(name)}`;
      }
      names.add(name);
    }
  }
  return [...names];
}

function refused(reason: string): SparseRestoreResult {
  return { ok: false, reason };
}
