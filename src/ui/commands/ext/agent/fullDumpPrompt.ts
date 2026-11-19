import * as vscode from 'vscode';
import type { AgentFullDumpDecision, AgentFullDumpRequest } from '../../../../infra/agent/AgentOperationService';

const DUMP_ACTION = 'Полная выгрузка на сервере';
const MANUAL_ACTION = 'Выгружу вручную';
const LOAD_DUMP_ACTION = 'Выгрузить на сервере';
const REWRITE_ACTION = 'Перезаписать зеркало на сервере';
const CANCEL_ACTION = 'Отмена';

/**
 * Вопрос перед полной серверной выгрузкой импорта. Вопрос с ответом, а не уведомление: операция ждёт
 * решения, запрет №18 его не касается. Закрытие диалога — отказ: дорогая выгрузка без явного согласия
 * не запускается, а отказ сопровождается инструкцией ручной выгрузки (её подхватит следующий импорт).
 */
export async function promptFullDump(request: AgentFullDumpRequest): Promise<AgentFullDumpDecision> {
  if (request.operation === 'load') {
    return promptLoadMirrorDump(request);
  }
  if (!request.download) {
    return promptMirrorRewrite(request);
  }
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

/**
 * Перезапись зеркала на сервере (запасной путь импорта при `FullDump`): архива нет, поэтому и ручная
 * выгрузка проекта не предлагается — она не дешевле. Цена — долгая выгрузка на сервере.
 */
async function promptMirrorRewrite(request: AgentFullDumpRequest): Promise<AgentFullDumpDecision> {
  const answer = await vscode.window.showWarningMessage(
    `Импорт «${request.targetName}» требует перезаписать зеркало агента на сервере: ${request.reasonText}.`,
    {
      modal: true,
      detail: 'Скачиваются только изменённые файлы, но выгрузка конфигурации на сервере для большой конфигурации долгая — десятки минут.',
    },
    REWRITE_ACTION,
    CANCEL_ACTION
  );
  return answer === REWRITE_ACTION ? 'dump' : 'cancel';
}

/** На загрузке скачивания нет и ручная выгрузка проекта не помогает: нужна только подготовка зеркала. */
async function promptLoadMirrorDump(request: AgentFullDumpRequest): Promise<AgentFullDumpDecision> {
  const answer = await vscode.window.showWarningMessage(
    `Загрузка изменений «${request.targetName}» требует подготовить зеркало агента: полная выгрузка ` +
    `конфигурации на сервере (${request.reasonText}).`,
    {
      modal: true,
      detail: 'Скачивания нет, но для большой конфигурации это десятки минут.',
    },
    LOAD_DUMP_ACTION,
    CANCEL_ACTION
  );
  return answer === LOAD_DUMP_ACTION ? 'dump' : 'cancel';
}
