import type { LoadVerification } from '../../../domain/agent';
import { formatByteSize } from '../sync/TransferProgressText';

/**
 * Тексты отказов и предупреждений операций с CF/CFE-файлами через агента (plan-remote-extensions §5.1).
 * Живут рядом с решениями в infra: UI их не собирает, а показывает как есть (MCP отдаёт агенту дословно).
 */

/** Предмет операции в тексте: «расширения «X»» или «основной конфигурации». */
export function subjectOf(extensionName: string | undefined): string {
  return extensionName ? `расширения «${extensionName}»` : 'основной конфигурации';
}

/** E7: `load-cfg` нового прошёл, `update-db-cfg` — нет; в базе осталась заглушка. */
export function appliedFailedText(name: string, agentText: string): string {
  return `Расширение «${name}» загружено, но не применено: ${agentText}. Вероятно, внутреннее имя расширения в файле ` +
    `совпадает с другим расширением базы. В базе осталась неприменённая заглушка «${name}» — удалите её в Конфигураторе.`;
}

/** Отказ `load-cfg` нового имени: могла остаться заглушка (Э28). */
export function newLoadFailedText(name: string, agentText: string): string {
  return `${agentText} — состояние расширения «${name}» в базе неопределённо (могла остаться неприменённая заглушка); ` +
    'проверьте базу в Конфигураторе.';
}

/** Отказ `load-cfg` существующего расширения или основной конфигурации. */
export function loadFailedText(subject: string, agentText: string): string {
  return `${agentText} — часть изменений могла быть применена, проверьте состояние ${subject} в базе.`;
}

/** E8. */
export function dumpFileMissingText(rel: string): string {
  return `Агент сообщил об успешной выгрузке, но файл на сервере не создан или пуст: ${rel}.`;
}

/** E9. */
export function notEnoughSpaceText(size: number, free: number, dir: string): string {
  return `Недостаточно места для файла ${formatByteSize(size)}: свободно ${formatByteSize(free)} в ${dir}.`;
}

/**
 * E11: имя в базе взято из файла (ФАКТ Э29, П4). Запрошенного имени в базе больше нет — каталог проекта
 * `src/cfe/<запрошенное>`, если он есть, указывает на несуществующее расширение.
 */
export function renamedWarningText(actualName: string, requested: string): string {
  return `Расширение загружено под именем из файла: «${actualName}» (запрошено «${requested}»). Расширения ` +
    `«${requested}» в базе нет: цель проекта cfe/${requested}, если она есть, указывает на несуществующее расширение.`;
}

/** Этап, после которого сверяется список: загрузка нового расширения или применение существующего. */
export type VerificationStage = 'load' | 'apply';

/** E12 (и предупреждение пакета): после применения имени нет среди применённых расширений. */
export function verificationProblemText(name: string, status: 'stub' | 'missing', stage: VerificationStage = 'load'): string {
  const detail = status === 'stub' ? 'осталась неприменённая заглушка' : 'в списке расширений его нет';
  const after = stage === 'load' ? 'загрузки' : 'применения';
  return `После ${after} расширения «${name}» его нет среди применённых расширений базы (${detail}) — состояние ` +
    'неопределённо, проверьте базу в Конфигураторе.';
}

/** Сверка списком после изменения базы не удалась: команда прошла, результат не подтверждён. */
export function verificationFailedText(name: string, reason: string): string {
  return `Расширение «${name}» обработано в базе, но проверить результат по списку расширений не удалось: ${reason}. ` +
    'Проверьте базу в Конфигураторе.';
}

/** Отмена пришла после `load-cfg` нового имени: применение доведено, иначе осталась бы заглушка (Э28). */
export function cancelledAfterLoadText(name: string): string {
  return `Отмена пришла после загрузки в базу: расширение «${name}» применено, чтобы в базе не осталась ` +
    'неприменённая заглушка.';
}

/** Итог сверки как предупреждение (`renamed`, `stub`, `missing`) или ничего (`ok`). */
export function verificationWarningOf(verification: LoadVerification, requested: string): string | undefined {
  if (verification.status === 'ok') {
    return undefined;
  }
  return verification.status === 'renamed'
    ? renamedWarningText(verification.actualName, requested)
    : verificationProblemText(requested, verification.status);
}
