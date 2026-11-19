/**
 * Э9 / Н5: аргументы подключения к ИБ пакетного Конфигуратора живут рядом с исполнителями —
 * `infra/process/designer/InfoBaseConnectionArgs.ts` (им пользуются все CLI-команды Конфигуратора и построитель
 * хранилища; в `infra/repository` ему не место).
 *
 * Контракт: `export interface InfoBaseConnection { infoBasePath?; infoBaseServer?; infoBaseRef?; userName?; password? }`,
 * `export function buildInfoBaseConnectionArgs(connection: InfoBaseConnection): string[]` — поведение прежнее:
 * `/S сервер/база` приоритетнее `/F путь`; `/N<имя>` и `/P<пароль>` СЛИТНО; без подключения — ошибка. Прежний импорт из
 * `infra/repository/RepositoryDesignerArgs` остаётся рабочим (реэкспорт) — один и тот же объект функции.
 */
import * as assert from 'assert';
import * as repositoryArgs from '../../infra/repository/RepositoryDesignerArgs';
import {
  buildInfoBaseConnectionArgs,
  type InfoBaseConnection,
} from '../../infra/process/designer/InfoBaseConnectionArgs';

suite('Э9 / Н5: buildInfoBaseConnectionArgs (infra/process/designer)', () => {
  const table: { title: string; connection: InfoBaseConnection; expected: string[] }[] = [
    { title: 'файловая база', connection: { infoBasePath: 'C:\\Базы\\Тест' }, expected: ['/F', 'C:\\Базы\\Тест'] },
    { title: 'серверная база', connection: { infoBaseServer: 'srv', infoBaseRef: 'prod' }, expected: ['/S', 'srv/prod'] },
    {
      title: 'сервер приоритетнее файла',
      connection: { infoBasePath: 'C:\\base', infoBaseServer: 'srv', infoBaseRef: 'prod' },
      expected: ['/S', 'srv/prod'],
    },
    { title: 'сервер без имени базы — файл', connection: { infoBasePath: 'C:\\base', infoBaseServer: 'srv' }, expected: ['/F', 'C:\\base'] },
    {
      title: 'пользователь и пароль слитно с ключом',
      connection: { infoBasePath: 'base', userName: 'Админ', password: 'п"ароль' },
      expected: ['/F', 'base', '/NАдмин', '/Pп"ароль'],
    },
    { title: 'пустой пароль и пользователь не добавляются', connection: { infoBasePath: 'base', userName: '', password: '' }, expected: ['/F', 'base'] },
  ];
  for (const row of table) {
    test(row.title, () => {
      assert.deepStrictEqual(buildInfoBaseConnectionArgs(row.connection), row.expected);
    });
  }

  test('нет ни пути, ни сервера с базой: понятная ошибка', () => {
    assert.throws(() => buildInfoBaseConnectionArgs({ userName: 'u' }), /Недостаточно параметров подключения к базе/);
  });

  test('прежний импорт из RepositoryDesignerArgs — реэкспорт той же функции', () => {
    assert.strictEqual(repositoryArgs.buildInfoBaseConnectionArgs, buildInfoBaseConnectionArgs);
  });
});
