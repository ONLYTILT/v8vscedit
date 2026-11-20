import {
  buildExtensionsPropertiesGetAllCommand,
  hasExtension,
  parseExtensionProperties,
  verifyNewExtensionLoad,
  type AgentExtensionInfo,
} from '../../../domain/agent';
import { compareExtensionNames } from '../../cfFile/CfeBatchNaming';
import type { AgentCommandExecutor } from '../AgentInfoBaseSession';
import { describeAgentCommandFailure } from '../AgentTransport';
import {
  renamedWarningText,
  verificationFailedText,
  verificationProblemText,
  type VerificationStage,
} from './AgentExtensionMessages';

/**
 * Срок ответа на КОРОТКУЮ команду агента (список расширений). Список на 12 расширениях — 2 мс (ФАКТ Э29, П1);
 * срок — общая защита от неответа (известного триггера нет, Э30–Э31). 30 с — с большим запасом на медленный
 * сервер и остаётся терпимым ожиданием для человека.
 */
export const AGENT_SHORT_COMMAND_DEADLINE_MS = 30_000;

/** Расширения базы, отсортированные `compareExtensionNames`; заглушки остаются в списке (делит вызывающий). */
export async function listDatabaseExtensions(exec: AgentCommandExecutor): Promise<AgentExtensionInfo[]> {
  // При одном расширении ответ — одно `extension-properties` без `success` (ФАКТ Э30–Э31): оно завершает ответ.
  const result = await exec.execute(buildExtensionsPropertiesGetAllCommand(), {
    deadlineMs: AGENT_SHORT_COMMAND_DEADLINE_MS,
    terminalTypes: ['extension-properties'],
  });
  return parseExtensionProperties(result.messages).sort((left, right) => compareExtensionNames(left.name, right.name));
}

/**
 * Guard перед `update-db-cfg --extension=X`: агент на применение отсутствующего расширения отвечает успехом
 * молча (Э28), поэтому наличие проверяется заранее (E6), команда в этом случае не отправляется. Заглушка
 * считается существующей. Возвращает список «до применения» — по нему сверяется имя после.
 */
export async function requireExtensionInDatabase(exec: AgentCommandExecutor, name: string): Promise<AgentExtensionInfo[]> {
  const infos = await listDatabaseExtensions(exec);
  if (!hasExtension(infos, name)) {
    throw new Error(
      `Расширения «${name}» нет в базе — применять нечего (агент конфигуратора на применение несуществующего ` +
      'расширения отвечает успехом, поэтому наличие проверяется заранее).'
    );
  }
  return infos;
}

/** Список «до» без цели: для заглушки и существующего имени сверка ищет имя, появившееся ПОСЛЕ применения. */
export function withoutName(infos: readonly AgentExtensionInfo[], name: string): AgentExtensionInfo[] {
  const lower = name.toLowerCase();
  return infos.filter((info) => info.name.toLowerCase() !== lower);
}

export interface AppliedVerification {
  readonly warnings: string[];
  /** Имя в базе после применения, если оно взято из файла (ФАКТ Э29, П4). */
  readonly renamedTo?: string;
}

/**
 * Сверка списком после `update-db-cfg` — одна политика для загрузки нового расширения и применения
 * существующего: имя из файла (`renamed`) — предупреждение E11; «применили, а применённого нет» (заглушка или
 * имени нет) — ошибка E12: команда прошла, но итог в базе неопределён, и молча считать его успехом нельзя.
 * Сбой САМОГО списка после изменения базы — предупреждение: база уже изменена, исход команды не теряется.
 */
export async function verifyAppliedExtension(
  exec: AgentCommandExecutor,
  before: readonly AgentExtensionInfo[],
  name: string,
  stage: VerificationStage
): Promise<AppliedVerification> {
  let after: AgentExtensionInfo[];
  try {
    after = await listDatabaseExtensions(exec);
  } catch (error) {
    return { warnings: [verificationFailedText(name, describeAgentCommandFailure(error))] };
  }
  const verification = verifyNewExtensionLoad(withoutName(before, name), after, name);
  if (verification.status === 'stub' || verification.status === 'missing') {
    throw new Error(verificationProblemText(name, verification.status, stage));
  }
  return verification.status === 'renamed'
    ? { warnings: [renamedWarningText(verification.actualName, name)], renamedTo: verification.actualName }
    : { warnings: [] };
}
