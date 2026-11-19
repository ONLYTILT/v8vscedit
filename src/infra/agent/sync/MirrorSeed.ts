import * as fs from 'fs';
import * as path from 'path';
import type { AgentConfigurationOperationTarget } from '../AgentOperationService';
import { ConfigXmlReader } from '../../xml/ConfigXmlReader';
import { readConfigDumpInfoHeader } from '../../xml/dumpInfo/ConfigDumpInfoHeader';
import { isKnownFormatVersion } from '../../xml/format/formatRegistry';
import { extractMetaDataObjectVersion } from '../../xml/XmlUtils';
import { CONFIG_DUMP_INFO_XML, CONFIGURATION_XML } from './ProjectFiles';
import { withTransferCancellation, type SyncOperationContext } from './SyncContext';

/**
 * Посев зеркала M без полной выгрузки в него: M — это файл версий и Configuration.xml, по которым
 * агент строит точный `--get-changes` и дописывает `dump --update` только файлы изменённых объектов
 * (пилот, эксперимент 9). Такой M разреженный (`mirrorCoverage: 'sparse'`): присутствующий файл
 * равен БД, отсутствующий не означает ничего.
 *
 * Источник посева — выгрузка проекта (с согласия пользователя: её файл версий может быть старше
 * ручных правок XML) или архив первого импорта (файл версий архива точен, согласие не нужно).
 */

export type MirrorSeedRejection =
  | 'missing-dump-info'
  | 'missing-configuration'
  | 'kind-mismatch'
  | 'name-mismatch'
  | 'dump-format'
  | 'format-unknown'
  | 'format-mismatch';

export interface MirrorSeedCandidate {
  readonly targetKind: 'cf' | 'cfe';
  readonly targetName: string;
  readonly projectDir: string;
  readonly formatVersion: string;
  readonly dumpInfoModifiedAt: Date;
  readonly dumpInfoSize: number;
}

export type MirrorSeedInspection =
  | { readonly ok: true; readonly candidate: MirrorSeedCandidate }
  | { readonly ok: false; readonly reason: MirrorSeedRejection; readonly message: string };

const HIERARCHICAL = 'Hierarchical';

/**
 * Дешёвые проверки пригодности выгрузки проекта для посева — до вопроса пользователю: файл версий
 * читается только заголовком, а не целиком (у большой конфигурации он — десятки мегабайт).
 */
export function inspectProjectMirrorSeed(
  target: AgentConfigurationOperationTarget,
  extensionName: string | undefined
): MirrorSeedInspection {
  const projectDir = target.rootPath;
  const dumpInfoPath = path.join(projectDir, CONFIG_DUMP_INFO_XML);
  const configurationPath = path.join(projectDir, CONFIGURATION_XML);
  const dumpInfo = statFile(dumpInfoPath);
  if (dumpInfo === undefined) {
    return rejected('missing-dump-info', `в выгрузке проекта нет файла версий ${CONFIG_DUMP_INFO_XML}`);
  }
  if (statFile(configurationPath) === undefined) {
    return rejected('missing-configuration', `в выгрузке проекта нет ${CONFIGURATION_XML}`);
  }
  const info = new ConfigXmlReader().read(configurationPath);
  if (info.kind !== target.kind) {
    return rejected('kind-mismatch', `выгрузка проекта — ${kindLabel(info.kind)}, а импортируется ${kindLabel(target.kind)}`);
  }
  const expectedName = extensionName ?? target.name;
  if (info.name !== expectedName) {
    return rejected('name-mismatch', `в выгрузке проекта «${info.name}», а импортируется «${expectedName}»`);
  }
  const header = readConfigDumpInfoHeader(dumpInfoPath);
  if (header?.format !== HIERARCHICAL) {
    return rejected('dump-format', `файл версий проекта не иерархической выгрузки (формат «${header?.format ?? 'не распознан'}»)`);
  }
  if (!isKnownFormatVersion(header.version)) {
    return rejected('format-unknown', `версия формата выгрузки проекта ${header.version} неизвестна`);
  }
  const configurationVersion = extractMetaDataObjectVersion(fs.readFileSync(configurationPath, 'utf-8'));
  if (configurationVersion !== header.version) {
    return rejected(
      'format-mismatch',
      `версия формата файла версий (${header.version}) не совпадает с версией ${CONFIGURATION_XML} (${String(configurationVersion)})`
    );
  }
  return {
    ok: true,
    candidate: {
      targetKind: target.kind,
      targetName: expectedName,
      projectDir,
      formatVersion: header.version,
      dumpInfoModifiedAt: dumpInfo.mtime,
      dumpInfoSize: dumpInfo.size,
    },
  };
}

/** Строка — локальный путь (закачка потоком), данные — содержимое записи архива. */
export interface MirrorSeedSource {
  readonly configuration: string | Uint8Array;
  readonly dumpInfo: string | Uint8Array;
}

/**
 * M очищается и получает Configuration.xml, затем файл версий — ПОСЛЕДНИМ: по нему импорт признаёт
 * M достоверным, и при сбое между записями M остаётся недостоверным, а не «засеянным наполовину».
 */
export async function seedMirror(context: SyncOperationContext, source: MirrorSeedSource): Promise<void> {
  const { store } = context;
  const mirror = context.workspace.targetAgentDir;
  const cancellation = context.hooks?.cancellation;
  const put = (rel: string, data: string | Uint8Array): Promise<void> => (typeof data === 'string'
    ? store.uploadFromFile(data, `${mirror}/${rel}`, { cancellation })
    : store.writeFile(`${mirror}/${rel}`, data));
  context.markMirrorMutated();
  // Разреженность — с первой мутации, а не после успеха: сбой посреди посева оставляет его неполным,
  // и полнота `full` в манифесте после такого сбоя разрешила бы удаления по отсутствию в M.
  context.mirror.coverage = 'sparse';
  await withTransferCancellation(async () => {
    await store.remove(mirror, { recursive: true });
    await store.mkdirp(mirror);
    await put(CONFIGURATION_XML, source.configuration);
    await put(CONFIG_DUMP_INFO_XML, source.dumpInfo);
  });
}

function statFile(filePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(filePath);
  } catch {
    return undefined;
  }
}

function rejected(reason: MirrorSeedRejection, message: string): MirrorSeedInspection {
  return { ok: false, reason, message: `Посев зеркала агента из выгрузки проекта невозможен: ${message}.` };
}

function kindLabel(kind: 'cf' | 'cfe'): string {
  return kind === 'cf' ? 'основная конфигурация' : 'расширение';
}
