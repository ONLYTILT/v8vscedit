import * as assert from 'assert';
import {
  parseRepositoryLockLog,
  resolveLockedFullNames,
  resolveNotCommittedFullNames,
  resolveOverwrittenLocked,
  resolveUnlockedFullNames,
} from '../../infra/repository/RepositoryLockLog';
import {
  BEGIN,
  C1, C3, D1,
  COMMIT_DONE, E33_1_LOG, E33_3_LOG, LOCK_DONE, UNLOCK_DONE, UPDATE_DONE,
  cancelledLine, changedLine, committedLine, foreignLine, lockedLine, notLockedLine, opLog, receivedLine, unchangedLine,
} from './support/repositoryListFixtures';

/**
 * Разбор логов операций хранилища для списков объектов (docs/plans/mcp-repository-paths-plan.md §1.4, тесты §4.B).
 * Строки логов — дословно из Э33 (8.3.27.2130): хвостовой пробел у строки чужого захвата, имена в одинарных
 * кавычках у «был изменен». Чистые функции, файлов и платформы нет.
 */

const ROOT_CF = '__configuration_root__';
const ROOT_CFE = '__extension_root__';

suite('RepositoryLockLog (paths): parseRepositoryLockLog', () => {
  test('notLockedByYou: строка «Объект не захвачен для редактирования:» — отдельное поле, лог распознан', () => {
    const parsed = parseRepositoryLockLog(notLockedLine(C3));
    assert.deepStrictEqual(parsed.notLockedByYou, [C3]);
    assert.strictEqual(parsed.recognized, true);
    assert.deepStrictEqual(parsed.locked, [], 'не пересекается с «захвачен для редактирования:»');
    assert.deepStrictEqual(parsed.lockedByOthers, []);
    assert.deepStrictEqual(parsed.cancelled, []);
  });

  test('notLockedByYou: несколько строк в порядке появления, остальные поля не затронуты', () => {
    const parsed = parseRepositoryLockLog(opLog(UNLOCK_DONE, cancelledLine(C1), notLockedLine(C3), notLockedLine(D1)));
    assert.deepStrictEqual(parsed.notLockedByYou, [C3, D1]);
    assert.deepStrictEqual(parsed.cancelled, [C1]);
  });

  test('changedInDatabase: «Объект \'<имя>\' был изменен» — имя без кавычек; кириллица; CRLF', () => {
    const parsed = parseRepositoryLockLog(`${BEGIN}\r\n${changedLine(C1)}\r\n${changedLine(D1)}\r\n`);
    assert.deepStrictEqual(parsed.changedInDatabase, [C1, D1]);
  });

  test('changedInDatabase: строка отказа не входит в распознаваемые — лог из одной такой строки не «распознан»', () => {
    const parsed = parseRepositoryLockLog(changedLine(C1));
    assert.deepStrictEqual(parsed.changedInDatabase, [C1]);
    assert.strictEqual(parsed.recognized, false);
  });

  test('Э33.3: лог атомарного отказа освобождения — только changedInDatabase, строк «отменен» нет', () => {
    const parsed = parseRepositoryLockLog(E33_3_LOG);
    assert.deepStrictEqual(parsed.changedInDatabase, [C1]);
    assert.deepStrictEqual(parsed.cancelled, []);
  });

  test('хвостовой пробел строки чужого захвата снимается: имя и пользователь без пробелов', () => {
    const line = foreignLine(D1, 'UserB');
    assert.ok(line.endsWith(') '), 'эталон содержит хвостовой пробел');
    const parsed = parseRepositoryLockLog(line);
    assert.deepStrictEqual(parsed.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.deepStrictEqual(parsed.locked, []);
    assert.deepStrictEqual(parsed.notLockedByYou, []);
  });

  test('Э33.1: захвачены С1 и С3, Д1 — у UserB', () => {
    const parsed = parseRepositoryLockLog(E33_1_LOG);
    assert.deepStrictEqual(parsed.locked, [C1, C3]);
    assert.deepStrictEqual(parsed.lockedByOthers, [{ name: D1, user: 'UserB' }]);
    assert.deepStrictEqual(parsed.changedInDatabase, []);
    assert.deepStrictEqual(parsed.notLockedByYou, []);
  });

  test('пустой лог: новые поля пусты', () => {
    const parsed = parseRepositoryLockLog('');
    assert.deepStrictEqual(parsed.notLockedByYou, []);
    assert.deepStrictEqual(parsed.changedInDatabase, []);
  });
});

suite('RepositoryLockLog (paths): resolveLockedFullNames с alreadyLocked', () => {
  test('Э33.(а): X уже захвачен этим пользователем, строки о нём нет — остаётся захваченным (порядок — как в запросе)', () => {
    const log = opLog(LOCK_DONE, lockedLine(C3));
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], log, [C1]), [C1, C3]);
  });

  test('без alreadyLocked (по умолчанию) прежнее поведение: только названное строкой', () => {
    const log = opLog(LOCK_DONE, lockedLine(C3));
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], log), [C3]);
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], log, []), [C3]);
  });

  test('X в учёте, но назван строкой чужого захвата — не захвачен', () => {
    const log = opLog(LOCK_DONE, lockedLine(C3), foreignLine(C1, 'UserB'));
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], log, [C1]), [C3]);
  });

  test('X в учёте, но назван среди отсутствующих в обеих конфигурациях — не захвачен', () => {
    const log = opLog(LOCK_DONE, lockedLine(C3), `Объекты, отсутствующие в обеих конфигурациях: ${C1}`);
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], log, [C1]), [C3]);
  });

  test('X без строки и не в учёте — не захвачен (захват мимо учёта расширения не подтверждён)', () => {
    const log = opLog(LOCK_DONE, lockedLine(C3));
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], log, ['Справочник.Другой']), [C3]);
  });

  test('Э33.1 (exit-1-лог): С1 и С3 захвачены, Д1 у чужого — не захвачен; правило то же, что при exit 0', () => {
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3, D1], E33_1_LOG, []), [C1, C3]);
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3, D1], E33_1_LOG, [D1]), [C1, C3], 'чужой захват перекрывает учёт');
  });

  test('служебное имя корня сохраняется правилом «не Тип.Имя», объекты — по логу', () => {
    const log = opLog(LOCK_DONE, lockedLine(C1));
    assert.deepStrictEqual(resolveLockedFullNames([ROOT_CF, C1, C3], log, []), [ROOT_CF, C1]);
    assert.deepStrictEqual(resolveLockedFullNames([ROOT_CFE, C1], E33_1_LOG, []), [ROOT_CFE, C1]);
  });

  test('лог не распознан: помечаются все запрошенные независимо от alreadyLocked', () => {
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], '', []), [C1, C3]);
    assert.deepStrictEqual(resolveLockedFullNames([C1, C3], 'неизвестный формат', [C1]), [C1, C3]);
  });
});

suite('RepositoryLockLog (paths): resolveUnlockedFullNames', () => {
  test('Э33.(б): рекурсивный корень — «отменен» по ВСЕМ объектам + «не захвачен» + «чужой»: освобождено только реальное', () => {
    const log = opLog(
      UNLOCK_DONE,
      cancelledLine(C1), cancelledLine(C3), cancelledLine(D1),
      notLockedLine(C3),
      foreignLine(D1, 'UserB')
    );
    assert.deepStrictEqual(resolveUnlockedFullNames([ROOT_CF], log), [ROOT_CF, C1]);
  });

  test('Э33.(б) для объектного списка: «отменен» − «не захвачен» − «чужой», в написании запроса', () => {
    const log = opLog(UNLOCK_DONE, cancelledLine(C1), cancelledLine(C3), cancelledLine(D1), notLockedLine(C3), foreignLine(D1, 'UserB'));
    assert.deepStrictEqual(resolveUnlockedFullNames([C1, C3, D1], log), [C1]);
  });

  test('сравнение по ключу ru: другое написание в строках «не захвачен»/«чужой» тоже исключает', () => {
    const log = opLog(UNLOCK_DONE, cancelledLine(C1), cancelledLine(C3), notLockedLine(C3.toUpperCase()), foreignLine(C1.toLowerCase(), 'UserB'));
    assert.deepStrictEqual(resolveUnlockedFullNames([C1, C3], log), []);
  });

  test('Э33.7 (расширение): «отменен» по обоим запрошенным — освобождены оба', () => {
    const x = 'Справочник.Э33_X';
    const y = 'Справочник.Э33_Y';
    assert.deepStrictEqual(resolveUnlockedFullNames([x, y], opLog(UNLOCK_DONE, cancelledLine(x), cancelledLine(y))), [x, y]);
  });

  test('прежнее (Э24): отменённые вне запрошенных попадают в результат, запрошенные без строки — нет', () => {
    const log = opLog(UNLOCK_DONE, cancelledLine('Справочник.Другой'));
    assert.deepStrictEqual(resolveUnlockedFullNames([C1], log), ['Справочник.Другой']);
  });

  test('прежнее (Э24): чужой захват без строк «отменен» — ничего не освобождено; служебное имя корня сохраняется', () => {
    assert.deepStrictEqual(resolveUnlockedFullNames([C1], opLog(UNLOCK_DONE, foreignLine(C1, 'Иванов'))), []);
    assert.deepStrictEqual(resolveUnlockedFullNames([ROOT_CF], opLog(UNLOCK_DONE, cancelledLine(C1))), [ROOT_CF, C1]);
  });

  test('прежнее: нераспознанный лог — все запрошенные; маркер без строк — ничего', () => {
    assert.deepStrictEqual(resolveUnlockedFullNames([C1, C3], ''), [C1, C3]);
    assert.deepStrictEqual(resolveUnlockedFullNames([C1, C3], opLog(UNLOCK_DONE)), []);
  });

  test('Э33.3: лог атомарного отказа (только «был изменен») — освобождено ничего', () => {
    assert.deepStrictEqual(resolveUnlockedFullNames([C1, C3], E33_3_LOG), []);
  });
});

suite('RepositoryLockLog (paths): resolveOverwrittenLocked', () => {
  test('лог без маркера начала операции — консервативно все захваченные (копия)', () => {
    const locked = [C1, C3];
    const result = resolveOverwrittenLocked(locked, '');
    assert.deepStrictEqual(result, [C1, C3]);
    assert.notStrictEqual(result, locked);
    assert.deepStrictEqual(resolveOverwrittenLocked(locked, 'ошибка без маркера'), [C1, C3]);
  });

  test('Э33.6: С1 захвачен и назван — перезаписан; Д1 назван, но не захвачен; С3 захвачен и не назван — не затронут', () => {
    const log = opLog(UPDATE_DONE, receivedLine(C1), receivedLine(D1));
    assert.deepStrictEqual(resolveOverwrittenLocked([C1, C3], log), [C1]);
  });

  test('Э33.6б: «получен» пишется и для перезаписи захваченного без новой версии в хранилище', () => {
    assert.deepStrictEqual(resolveOverwrittenLocked([C1], opLog(UPDATE_DONE, receivedLine(C1))), [C1]);
  });

  test('Э33.6в: незатронутый объект не упоминается (нет строк) — перезаписанных нет', () => {
    assert.deepStrictEqual(resolveOverwrittenLocked([C1, C3], opLog(UPDATE_DONE)), []);
  });

  test('подобъект: строка «получен» по форме объекта включает владельца', () => {
    const log = opLog(UPDATE_DONE, receivedLine(`${C1}.Форма.Основная`));
    assert.deepStrictEqual(resolveOverwrittenLocked([C1, C3], log), [C1]);
  });

  test('префикс-ловушка: «Справочник.Товары» не покрывает «Справочник.Товар» и наоборот; подобъект «Справочник.Товар.…» — покрывает', () => {
    assert.deepStrictEqual(resolveOverwrittenLocked(['Справочник.Товар'], opLog(UPDATE_DONE, receivedLine('Справочник.Товары'))), []);
    assert.deepStrictEqual(resolveOverwrittenLocked(['Справочник.Товары'], opLog(UPDATE_DONE, receivedLine('Справочник.Товар'))), []);
    assert.deepStrictEqual(
      resolveOverwrittenLocked(['Справочник.Товар'], opLog(UPDATE_DONE, receivedLine('Справочник.Товар.Реквизит.Ц'))),
      ['Справочник.Товар']
    );
  });

  test('строка «Объект удален из конфигурации:» тоже считается затронувшей объект', () => {
    const log = opLog(UPDATE_DONE, `Объект удален из конфигурации: ${C1}`);
    assert.deepStrictEqual(resolveOverwrittenLocked([C1, C3], log), [C1]);
  });

  test('регистр: сравнение по ключу ru, в результате — написание из учёта', () => {
    const log = opLog(UPDATE_DONE, receivedLine(C1.toLowerCase()));
    assert.deepStrictEqual(resolveOverwrittenLocked([C1], log), [C1]);
  });

  test('служебное имя корня: включается, если есть хоть одна строка; без строк — нет (корень и расширения)', () => {
    const named = opLog(UPDATE_DONE, receivedLine(D1));
    assert.deepStrictEqual(resolveOverwrittenLocked([ROOT_CF, C1], named), [ROOT_CF]);
    assert.deepStrictEqual(resolveOverwrittenLocked([ROOT_CFE, C1], named), [ROOT_CFE]);
    assert.deepStrictEqual(resolveOverwrittenLocked([ROOT_CF, C1], opLog(UPDATE_DONE)), []);
  });

  test('порядок результата — как в locked; пустой учёт — пусто', () => {
    const log = opLog(UPDATE_DONE, receivedLine(D1), receivedLine(C1));
    assert.deepStrictEqual(resolveOverwrittenLocked([C1, D1], log), [C1, D1]);
    assert.deepStrictEqual(resolveOverwrittenLocked([], log), []);
  });
});

suite('RepositoryLockLog (paths): resolveNotCommittedFullNames', () => {
  test('Э33.4а: «помещен» С1, «не был изменен» С3 — не помещённых нет', () => {
    const log = opLog(COMMIT_DONE, committedLine(C1), unchangedLine(C3));
    assert.deepStrictEqual(resolveNotCommittedFullNames([C1, C3], log), []);
  });

  test('Э33.4б/в: незахваченный и чужой объект пропускаются молча (exit 0) — Д1 не помещён', () => {
    const log = opLog(COMMIT_DONE, committedLine(C1));
    assert.deepStrictEqual(resolveNotCommittedFullNames([C1, D1], log), [D1]);
  });

  test('ни одна строка не называет запрошенных: все не помещены, в порядке запроса', () => {
    assert.deepStrictEqual(resolveNotCommittedFullNames([C1, C3], opLog(COMMIT_DONE)), [C1, C3]);
  });

  test('нераспознанный лог (нет маркера) — [] (согласовано с «консервативно всё помещено»)', () => {
    assert.deepStrictEqual(resolveNotCommittedFullNames([C1, C3], ''), []);
    assert.deepStrictEqual(resolveNotCommittedFullNames([C1, C3], 'без маркера'), []);
  });

  test('служебное имя корня никогда не попадает в не помещённые', () => {
    assert.deepStrictEqual(resolveNotCommittedFullNames([ROOT_CF, C1], opLog(COMMIT_DONE, committedLine(C1))), []);
    assert.deepStrictEqual(resolveNotCommittedFullNames([ROOT_CFE, C1], opLog(COMMIT_DONE)), [C1]);
  });

  test('регистр: имя названо в другом написании — помещено', () => {
    assert.deepStrictEqual(resolveNotCommittedFullNames([C1], opLog(COMMIT_DONE, committedLine(C1.toLowerCase()))), []);
    assert.deepStrictEqual(resolveNotCommittedFullNames([C1], opLog(COMMIT_DONE, unchangedLine(C1.toUpperCase()))), []);
  });
});
