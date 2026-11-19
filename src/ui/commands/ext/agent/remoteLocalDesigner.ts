import * as fs from 'fs';
import {
  classifyInfoBaseConnection,
  type InfoBaseConnectionKind,
} from '../../../../infra/process/designer/InfoBaseConnectionArgs';
import { readAgentLocation } from './agentSettings';

/**
 * Н51: операции, которые в удалённом режиме агента по-прежнему идут ЛОКАЛЬНЫМ 1cv8 (внутренний CLI —
 * загрузка/выгрузка CF/CFE, пакеты расширений, список расширений; интерактивный Конфигуратор).
 *
 * Клиент-серверная база (`/S`) с машины пользователя — та же база по сети: операция выполняется,
 * только медленнее, и тотальный отказ лишил бы пользователя этих операций без замены. Файловая база
 * (`/F`) — путь на сервере: локальному 1cv8 он недоступен или указывает на ДРУГУЮ базу, поэтому отказ
 * до любых побочных эффектов. Вид не распознан (нет env.json, иная форма) — как раньше: операция сама
 * сообщит о проблеме подключения.
 */
export type LocalDesignerDecision =
  | { readonly action: 'run'; readonly notice?: string }
  | { readonly action: 'refuse'; readonly reason: string };

export type LocalDesignerUse = 'batch' | 'interactive';

export function decideLocalDesignerInRemote(kind: InfoBaseConnectionKind | undefined, use: LocalDesignerUse): LocalDesignerDecision {
  if (readAgentLocation() !== 'remote' || kind === undefined) {
    return { action: 'run' };
  }
  if (kind === 'server') {
    return {
      action: 'run',
      notice: use === 'batch'
        ? 'Удалённый режим агента: операция выполняется локальным Конфигуратором по сети (клиент-серверная база).'
        : 'Удалённый режим агента: Конфигуратор запускается на этой машине и подключается к клиент-серверной базе по сети.',
    };
  }
  if (kind === 'server-loopback') {
    const subject = use === 'batch' ? 'пакетные операции Конфигуратора выполнять нечем' : 'Конфигуратор на этой машине не запускается';
    return {
      action: 'refuse',
      reason: `Удалённый режим агента (v8vscedit.agent.location = "remote"): ${subject} — сервер базы в --ibconnection ` +
        'указан петлевым адресом (localhost, 127.0.0.1, «.», ::1), то есть с точки зрения сервера 1С, и локальный 1cv8 ' +
        'ушёл бы в кластер на этой машине. Укажите сетевое имя сервера в --ibconnection или верните ' +
        'v8vscedit.agent.location = "local".',
    };
  }
  return {
    action: 'refuse',
    reason: use === 'batch'
      ? 'Удалённый режим агента (v8vscedit.agent.location = "remote") с файловой базой: пакетные операции Конфигуратора ' +
        'выполнять нечем — путь базы указан для сервера, и локальный 1cv8 его не видит (или открыл бы другую базу). ' +
        'Используйте клиент-серверную базу (/S) или верните v8vscedit.agent.location = "local".'
      : 'Удалённый режим агента (v8vscedit.agent.location = "remote") с файловой базой: Конфигуратор на этой машине ' +
        'не откроет базу по серверному пути. Запустите Конфигуратор на сервере или используйте клиент-серверную базу (/S).',
  };
}

/** Вид базы по `--ibconnection` из env.json; файла нет или он битый — `undefined`. */
export function readInfoBaseConnectionKind(settingsPath: string): InfoBaseConnectionKind | undefined {
  try {
    // Нет секции default или ключа — исключение/нестроковое значение, то есть «не распознано».
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { default: Record<string, unknown> };
    return classifyInfoBaseConnection(String(parsed.default['--ibconnection']));
  } catch {
    return undefined;
  }
}
