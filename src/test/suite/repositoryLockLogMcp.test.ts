import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectSecretStorage } from '../../infra/environment/ProjectSecretStorage';
import {
  hasReferencesCleaned,
  parseRepositoryCommitLog,
  parseRepositoryLockLog,
  resolveCommittedFullNames,
  resolveUnlockedFullNames,
} from '../../infra/repository/RepositoryLockLog';
import { RepositoryService } from '../../infra/repository/RepositoryService';
import { BEGIN, COMMIT_DONE, END, ROOT_LOCK_CF, UNLOCK_DONE, fakeSecretStore, opLog } from './support/repositoryMcpFixtures';
import { removeTreeSync } from './support/tempTree';

/**
 * Э24/Э25 (docs/plans/remote-designer-plan.md §5b п.31, 32): разбор логов освобождения и помещения и
 * `RepositoryService.listLockedFullNames`. Логи строятся из РЕАЛЬНЫХ строк платформы.
 * Ветки: чужой захват (с завершающим пробелом строки), частичное освобождение, служебные имена корня,
 * нераспознанный лог, регистр `ru`, CRLF/LF, «не был изменен», очистка ссылок, пустые входы.
 */

const FOREIGN = 'Объект захвачен для редактирования другим пользователем: ';

suite('RepositoryLockLog: чужой захват, освобождение по логу', () => {
  test('parseRepositoryLockLog: строка чужого захвата с завершающим пробелом → lockedByOthers {name, user}; не пересекается с «захвачен для редактирования:»', () => {
    const log = opLog(UNLOCK_DONE, `${FOREIGN}Справочник.Товары (Иванов) `, 'Объект захвачен для редактирования: Справочник.Склады');
    const parsed = parseRepositoryLockLog(log);
    assert.deepStrictEqual(parsed.lockedByOthers, [{ name: 'Справочник.Товары', user: 'Иванов' }]);
    assert.deepStrictEqual(parsed.locked, ['Справочник.Склады']);
    assert.strictEqual(parsed.recognized, true);
  });

  test('parseRepositoryLockLog: только строка чужого захвата — тоже «распознан»; несколько строк, пользователь с пробелом и скобками в имени объекта', () => {
    const parsed = parseRepositoryLockLog(
      [`${FOREIGN}Документ.Заказ (Пётр Петров) `, `${FOREIGN}Справочник.Склады (adm) `].join('\n')
    );
    assert.strictEqual(parsed.recognized, true);
    assert.deepStrictEqual(parsed.lockedByOthers, [
      { name: 'Документ.Заказ', user: 'Пётр Петров' },
      { name: 'Справочник.Склады', user: 'adm' },
    ]);
    assert.deepStrictEqual(parsed.locked, []);
  });

  test('parseRepositoryLockLog: строка чужого захвата без «(пользователь)» не ломает разбор — имя целиком, пользователь пуст', () => {
    const parsed = parseRepositoryLockLog(`${FOREIGN}Справочник.Товары `);
    assert.deepStrictEqual(parsed.lockedByOthers, [{ name: 'Справочник.Товары', user: '' }]);
  });

  test('parseRepositoryLockLog: прежние поля не изменились (locked/cancelled/absent), пустой лог — не распознан, lockedByOthers пуст', () => {
    const parsed = parseRepositoryLockLog(
      ['Объект захвачен для редактирования: А.Б', 'Захват объекта отменен: В.Г', 'Объекты, отсутствующие в обеих конфигурациях: Д.Е, Ж.З'].join('\r\n')
    );
    assert.deepStrictEqual([parsed.locked, parsed.cancelled, parsed.absent], [['А.Б'], ['В.Г'], ['Д.Е', 'Ж.З']]);
    const empty = parseRepositoryLockLog('');
    assert.strictEqual(empty.recognized, false);
    assert.deepStrictEqual(empty.lockedByOthers, []);
  });

  const UNLOCK_CASES: readonly { title: string; fullNames: string[]; log: string; expected: string[] }[] = [
    {
      title: 'нераспознанный лог (пустой) → все запрошенные',
      fullNames: ['Справочник.А', 'Справочник.Б'],
      log: '',
      expected: ['Справочник.А', 'Справочник.Б'],
    },
    {
      title: 'нераспознанный лог (мусор без известных префиксов) → все запрошенные',
      fullNames: ['Справочник.А'],
      log: 'что-то совсем иное\r\nещё строка',
      expected: ['Справочник.А'],
    },
    {
      title: 'частичное: отменён только один из запрошенных',
      fullNames: ['Справочник.А', 'Справочник.Б'],
      log: opLog(UNLOCK_DONE, 'Захват объекта отменен: Справочник.А'),
      expected: ['Справочник.А'],
    },
    {
      title: 'чужой захват и больше ничего: ничего не освобождено (Э24: exit 0, но захват НЕ снят)',
      fullNames: ['Справочник.А'],
      log: opLog(UNLOCK_DONE, `${FOREIGN}Справочник.А (Иванов) `),
      expected: [],
    },
    {
      title: 'отменён объект ВНЕ запрошенных (рекурсия подчинённых) — попадает в результат',
      fullNames: ['Справочник.А'],
      log: opLog(UNLOCK_DONE, 'Захват объекта отменен: Справочник.А', 'Захват объекта отменен: Справочник.Подчинённый'),
      expected: ['Справочник.А', 'Справочник.Подчинённый'],
    },
    {
      title: 'служебное имя корня (не «Тип.Имя») сохраняется, даже если лог его не называет',
      fullNames: [ROOT_LOCK_CF],
      log: opLog(UNLOCK_DONE, 'Захват объекта отменен: Справочник.А'),
      expected: [ROOT_LOCK_CF, 'Справочник.А'],
    },
    {
      title: 'сопоставление по регистру ru: «справочник.товары» в логе == «Справочник.Товары» в запросе — результат в написании ЗАПРОСА (по нему setLocked удаляет учёт), без дубля',
      fullNames: ['Справочник.Товары'],
      log: opLog(UNLOCK_DONE, 'Захват объекта отменен: справочник.товары'),
      expected: ['Справочник.Товары'],
    },
    {
      title: 'распознанный лог без строк «отменен» (маркеры есть, а объектных строк нет) — ничего, кроме служебных имён',
      fullNames: ['Справочник.А', ROOT_LOCK_CF],
      log: `Объект захвачен для редактирования: Справочник.Х\r\n${UNLOCK_DONE}`,
      expected: [ROOT_LOCK_CF],
    },
    {
      title: 'пустой список запрошенных и нераспознанный лог → пусто',
      fullNames: [],
      log: '',
      expected: [],
    },
  ];
  for (const row of UNLOCK_CASES) {
    test(`resolveUnlockedFullNames: ${row.title}`, () => {
      assert.deepStrictEqual(resolveUnlockedFullNames(row.fullNames, row.log), row.expected);
    });
  }
});

suite('RepositoryLockLog: помещение (Э25)', () => {
  const COMMITTED = opLog(
    COMMIT_DONE,
    'Объект помещен в хранилище: Справочник.Товары',
    'Объект не был изменен: Справочник.Склады',
    'Объект помещен в хранилище: Справочник.Товары.Форма.ФормаЭлемента'
  );

  test('parseRepositoryCommitLog: помещённые и неизменённые по строкам, маркер начала → recognized', () => {
    const parsed = parseRepositoryCommitLog(COMMITTED);
    assert.deepStrictEqual(parsed.committed, ['Справочник.Товары', 'Справочник.Товары.Форма.ФормаЭлемента']);
    assert.deepStrictEqual(parsed.unchanged, ['Справочник.Склады']);
    assert.strictEqual(parsed.recognized, true);
  });

  test('parseRepositoryCommitLog: CRLF и LF дают одно и то же; пробелы по краям строк игнорируются', () => {
    const lf = [BEGIN, '  Объект помещен в хранилище: Справочник.А  ', END].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    assert.deepStrictEqual(parseRepositoryCommitLog(lf), parseRepositoryCommitLog(crlf));
    assert.deepStrictEqual(parseRepositoryCommitLog(lf).committed, ['Справочник.А']);
  });

  test('parseRepositoryCommitLog: пустой лог и лог без маркера начала — recognized=false', () => {
    assert.strictEqual(parseRepositoryCommitLog('').recognized, false);
    const noBegin = parseRepositoryCommitLog('Объект помещен в хранилище: Справочник.А');
    assert.strictEqual(noBegin.recognized, false);
  });

  test('resolveCommittedFullNames: нераспознанный лог → все запрошенные (консервативно)', () => {
    assert.deepStrictEqual(resolveCommittedFullNames(['Справочник.А', 'Справочник.Б'], ''), ['Справочник.А', 'Справочник.Б']);
  });

  test('resolveCommittedFullNames: распознанный → имена из строк «помещен»; «не был изменен» не попадает', () => {
    assert.deepStrictEqual(
      resolveCommittedFullNames(['Справочник.Товары', 'Справочник.Склады'], COMMITTED),
      ['Справочник.Товары', 'Справочник.Товары.Форма.ФормаЭлемента']
    );
  });

  test('resolveCommittedFullNames: помещение без правок (все «не был изменен») → пусто', () => {
    const log = opLog(COMMIT_DONE, 'Объект не был изменен: Справочник.Товары');
    assert.deepStrictEqual(resolveCommittedFullNames(['Справочник.Товары'], log), []);
  });

  test('hasReferencesCleaned: строка «Очистка объектов от некорректных ссылок выполнена» → true; без неё, в пустом логе — false', () => {
    const cleaned = opLog(COMMIT_DONE, 'Очистка объектов от некорректных ссылок выполнена', 'Объект помещен в хранилище: Документ.Документ1');
    assert.strictEqual(hasReferencesCleaned(cleaned), true);
    assert.strictEqual(hasReferencesCleaned(`${BEGIN}\n  Очистка объектов от некорректных ссылок выполнена: 1\n${END}`), true, 'с хвостом после двоеточия/пробелами');
    assert.strictEqual(hasReferencesCleaned(COMMITTED), false);
    assert.strictEqual(hasReferencesCleaned(''), false);
  });
});

suite('RepositoryService.listLockedFullNames', () => {
  let root: string;
  let service: RepositoryService;
  let target: NonNullable<ReturnType<RepositoryService['resolveTargetByConfigRoot']>>;
  let otherTarget: typeof target;

  setup(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'v8vscedit-list-locked-')));
    const cfRoot = path.join(root, 'src', 'cf');
    const cfeRoot = path.join(root, 'src', 'cfe', 'Расш');
    for (const dir of [cfRoot, cfeRoot]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'Configuration.xml'),
        '<?xml version="1.0" encoding="UTF-8"?><MetaDataObject><Configuration uuid="11111111-1111-1111-1111-111111111111"><Properties><Name>К</Name></Properties></Configuration></MetaDataObject>');
    }
    fs.writeFileSync(path.join(root, 'env.json'), JSON.stringify({ default: { '--ibconnection': `/F${path.join(root, 'base')}` } }), 'utf-8');
    service = new RepositoryService(root, new ProjectSecretStorage(fakeSecretStore(), root));
    const first = service.resolveTargetByConfigRoot(cfRoot);
    const second = service.resolveTargetByConfigRoot(cfeRoot);
    assert.ok(first && second);
    target = first;
    otherTarget = second;
  });

  teardown(() => removeTreeSync(root));

  test('пусто → []; после setLocked — отсортированные имена цели; чужая цель не смешивается; возвращается копия', () => {
    assert.deepStrictEqual(service.listLockedFullNames(target), []);

    service.setLocked(target, ['Справочник.Яблоки', 'Справочник.Арбузы'], true);
    service.setLocked(otherTarget, ['Документ.Заказ'], true);
    const list = service.listLockedFullNames(target);
    assert.deepStrictEqual(list, ['Справочник.Арбузы', 'Справочник.Яблоки']);
    list.push('мусор');
    assert.deepStrictEqual(service.listLockedFullNames(target), ['Справочник.Арбузы', 'Справочник.Яблоки'], 'внутреннее состояние не изменяется снаружи');
    assert.deepStrictEqual(service.listLockedFullNames(otherTarget), ['Документ.Заказ']);
  });
});
