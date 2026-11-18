/**
 * Э9 / Н51: вид базы по строке подключения env.json (`--ibconnection`) —
 * `classifyInfoBaseConnection` (infra/process/designer/InfoBaseConnectionArgs.ts, чистая функция без vscode).
 *
 * От вида зависит, можно ли в удалённом режиме агента выполнить операцию ЛОКАЛЬНЫМ 1cv8: клиент-серверная база —
 * та же база по сети (выполняется), файловая — путь на сервере (отказ). Не распознано — `undefined`
 * (вызывающий ведёт себя как раньше). Регистр ключа и пробелы/кавычки по краям не влияют.
 *
 * Петлевой адрес сервера (`localhost`, `127.x.x.x`, `.`, `::1`, с портом или без) — отдельный вид
 * `server-loopback`: в удалённом режиме строка env.json записана с точки зрения СЕРВЕРА, и локальный 1cv8
 * по ней молча ушёл бы в кластер на машине пользователя (часто там локальная копия базы с тем же именем).
 */
import * as assert from 'assert';
import { classifyInfoBaseConnection } from '../../infra/process/designer/InfoBaseConnectionArgs';

suite('Э9 / Н51: classifyInfoBaseConnection — файловая или клиент-серверная база', () => {
  const table: { raw: string; expected: 'file' | 'server' | 'server-loopback' | undefined }[] = [
    { raw: '/FC:/Базы/Тест', expected: 'file' },
    { raw: '/F C:/Базы/Тест', expected: 'file' },
    { raw: '/fD:/base', expected: 'file' },
    { raw: '  /F/srv/share/base  ', expected: 'file' },
    { raw: '"/FC:/Базы/Тест База"', expected: 'file' },
    { raw: ' "/F C:/base" ', expected: 'file' },
    { raw: 'File="C:/Базы/Тест";', expected: 'file' },
    { raw: 'file = "C:/base"', expected: 'file' },
    { raw: '/Ssrv-1c/prod', expected: 'server' },
    { raw: '/S srv-1c/prod', expected: 'server' },
    { raw: '/ssrv/base', expected: 'server' },
    { raw: '  /S srv:1541/base  ', expected: 'server' },
    { raw: '"/Ssrv/base"', expected: 'server' },
    { raw: 'Srvr="srv";Ref="base";', expected: 'server' },
    { raw: 'srvr = "srv"; Ref="base"', expected: 'server' },
    { raw: '/Slocalhost/base', expected: 'server-loopback' },
    { raw: '/S localhost/base', expected: 'server-loopback' },
    { raw: '/S LOCALHOST/base', expected: 'server-loopback' },
    { raw: '/S localhost:1541/base', expected: 'server-loopback' },
    { raw: '/S 127.0.0.1/base', expected: 'server-loopback' },
    { raw: '/S 127.0.1.5:1541/base', expected: 'server-loopback' },
    { raw: '/S ./base', expected: 'server-loopback' },
    { raw: '/S .:1541/base', expected: 'server-loopback' },
    { raw: '/S ::1/base', expected: 'server-loopback' },
    { raw: '/S [::1]:1541/base', expected: 'server-loopback' },
    { raw: '/S localhost\\base', expected: 'server-loopback' },
    { raw: ' "/s Localhost/base" ', expected: 'server-loopback' },
    { raw: 'Srvr="localhost";Ref="base";', expected: 'server-loopback' },
    { raw: 'Srvr="localhost:1541";Ref="base";', expected: 'server-loopback' },
    { raw: 'srvr = "127.0.0.1"; Ref="base"', expected: 'server-loopback' },
    { raw: 'Srvr=localhost;Ref=base', expected: 'server-loopback' },
    { raw: '/S localhost-srv/base', expected: 'server' },
    { raw: '/S srv.localhost.corp/base', expected: 'server' },
    { raw: '/S 10.0.0.1:1541/base', expected: 'server' },
    { raw: '', expected: undefined },
    { raw: '   ', expected: undefined },
    { raw: 'C:/Базы/Тест', expected: undefined },
    { raw: '/WS http://host/base', expected: undefined },
    { raw: 'ws="http://host/base"', expected: undefined },
  ];
  for (const row of table) {
    test(`${JSON.stringify(row.raw)} → ${String(row.expected)}`, () => {
      assert.strictEqual(classifyInfoBaseConnection(row.raw), row.expected);
    });
  }
});
