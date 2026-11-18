import * as vscode from 'vscode';
import type { AgentFullDumpDecision, AgentFullDumpRequest } from '../../../../infra/agent/AgentOperationService';

const DUMP_ACTION = 'Полная выгрузка на сервере';
const MANUAL_ACTION = 'Выгружу вручную';

/**
 * Вопрос перед полной серверной выгрузкой импорта. Вопрос с ответом, а не уведомление: операция ждёт
 * решения, запрет №18 его не касается. Закрытие диалога — отказ: дорогая выгрузка без явного согласия
 * не запускается, а отказ сопровождается инструкцией ручной выгрузки (её подхватит следующий импорт).
 */
export async function promptFullDump(request: AgentFullDumpRequest): Promise<AgentFullDumpDecision> {
  const answer = await vscode.window.showWarningMessage(
    `Импорт «${request.targetName}» требует полной выгрузки конфигурации на сервере: ${request.reasonText}.`,
    {
      modal: true,
      detail:
        'Для большой конфигурации это десятки минут и скачивание сотен мегабайт. Можно выгрузить конфигурацию ' +
        'вручную (Конфигуратор на сервере → «Выгрузить конфигурацию в файлы», иерархический формат), перенести ' +
        `файлы и заменить ими ${request.projectDir} целиком, включая ConfigDumpInfo.xml: следующий импорт ` +
        'предложит взять их за основу.',
    },
    DUMP_ACTION,
    MANUAL_ACTION
  );
  return answer === DUMP_ACTION ? 'dump' : 'cancel';
}
