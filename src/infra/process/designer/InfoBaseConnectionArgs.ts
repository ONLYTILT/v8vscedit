/**
 * Аргументы подключения к информационной базе для пакетного Конфигуратора.
 *
 * Живут рядом с исполнителями (`infra/process/designer`), а не в `infra/repository`: ими пользуются
 * все CLI-команды Конфигуратора и построитель хранилища, а удалённый исполнитель (Э9) получает тот
 * же вектор — одна реализация вместо копий в каждом потребителе.
 */

/** Параметры подключения к информационной базе (подмножество env.json/CLI). */
export interface InfoBaseConnection {
  readonly infoBasePath?: string;
  readonly infoBaseServer?: string;
  readonly infoBaseRef?: string;
  readonly userName?: string;
  readonly password?: string;
}

/**
 * Аргументы подключения к ИБ: `/S сервер/база` (приоритет) или `/F путь`, затем
 * `/N<пользователь>` и `/P<пароль>` СЛИТНО — у платформы это один аргумент.
 */
export function buildInfoBaseConnectionArgs(connection: InfoBaseConnection): string[] {
  const args: string[] = [];
  if (connection.infoBaseServer && connection.infoBaseRef) {
    args.push('/S', `${connection.infoBaseServer}/${connection.infoBaseRef}`);
  } else if (connection.infoBasePath) {
    args.push('/F', connection.infoBasePath);
  } else {
    throw new Error('Недостаточно параметров подключения к базе: нужен путь файловой базы или сервер и имя базы.');
  }
  if (connection.userName) {
    args.push(`/N${connection.userName}`);
  }
  if (connection.password) {
    args.push(`/P${connection.password}`);
  }
  return args;
}

export type InfoBaseConnectionKind = 'file' | 'server' | 'server-loopback';

/**
 * Вид базы по строке подключения env.json (`--ibconnection`): `/F<путь>` или `File=` — файловая,
 * `/S<сервер>/<база>` или `Srvr=` — клиент-серверная, а с петлевым адресом сервера (`localhost`,
 * `127.x.x.x`, `.`, `::1`, с портом или без) — `server-loopback`; иное — `undefined` (не распознано).
 *
 * Н51: в удалённом режиме локальный 1cv8 ходит к клиент-серверной базе по сети (та же база),
 * а путь файловой базы на сервере для локального 1cv8 недоступен или указывает на ДРУГУЮ базу.
 * Петлевой адрес — тот же случай, что файловый путь: строка записана с точки зрения сервера, и
 * локальный 1cv8 молча ушёл бы в кластер на машине пользователя (часто с копией базы того же имени).
 */
export function classifyInfoBaseConnection(raw: string): InfoBaseConnectionKind | undefined {
  const value = raw.trim().replace(/^"+|"+$/g, '').trim();
  if (/^\/F/i.test(value) || /^File\s*=/i.test(value)) {
    return 'file';
  }
  const server = extractServerAddress(value);
  if (server === undefined) {
    return undefined;
  }
  return server.split(',').some(isLoopbackAddress) ? 'server-loopback' : 'server';
}

/** Адрес кластера (возможно, со списком и портами) из `/S сервер/база` или `Srvr="сервер";`. */
function extractServerAddress(value: string): string | undefined {
  const switchForm = /^\/S\s*([^/\\]*)/i.exec(value);
  if (switchForm) {
    return switchForm[1];
  }
  const keyForm = /^Srvr\s*=\s*"?([^";]*)/i.exec(value);
  return keyForm ? keyForm[1] : undefined;
}

function isLoopbackAddress(address: string): boolean {
  const host = address.trim().toLowerCase()
    .replace(/^\[([^\]]*)\](:\d+)?$/, '$1')
    .replace(/^([^:]*):\d+$/, '$1');
  return host === 'localhost' || host === '.' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}
