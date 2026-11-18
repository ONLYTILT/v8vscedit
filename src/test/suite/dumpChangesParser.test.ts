import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseDumpChanges, type DumpChangeSet } from '../../domain/agent/DumpChangesParser';

/**
 * Э7: разбор файла `dump-config-to-files --get-changes` (факты пилота, план §5/§5b п.8).
 * Формат — ПО ОБЪЕКТАМ: `<Change>: <EnglishKind>.<Name>[.<PartKind>[.<PartName>[.<SubPart>]]]`,
 * UTF-8 с BOM, CRLF; «нет изменений» — файл из одного BOM; любое удаление/переименование —
 * файл из одной строки `FullDump`. Всё непонятное → `unrecognized` ЦЕЛИКОМ (консервативно:
 * движок уходит в архивную ветку).
 */

const BOM = String.fromCharCode(0xfeff);

/** Реальный вывод агента из пилота (tmp/changes.txt): пустой модуль набора записей регистра сведений. */
const REAL_SAMPLE =
  BOM + 'New: InformationRegister.МК_ОчередьОбработкиДополнительнойИнформации.RecordSetModule\r\n' +
  'Modified: InformationRegister.МК_ОчередьОбработкиДополнительнойИнформации\r\n';

function objects(set: DumpChangeSet): { change: string; fullName: string }[] {
  assert.strictEqual(set.kind, 'objects', JSON.stringify(set));
  return set.objects.map((o) => ({ change: o.change, fullName: o.fullName }));
}

suite('DumpChangesParser (Э7)', () => {
  test('реальный образец пилота: две строки, часть + владелец, kind objects', () => {
    const set = parseDumpChanges(REAL_SAMPLE);
    assert.deepStrictEqual(objects(set), [
      { change: 'added', fullName: 'InformationRegister.МК_ОчередьОбработкиДополнительнойИнформации.RecordSetModule' },
      { change: 'modified', fullName: 'InformationRegister.МК_ОчередьОбработкиДополнительнойИнформации' },
    ]);
    assert.ok(set.kind === 'objects');
    assert.strictEqual(set.objects[0].kind, 'InformationRegister');
    assert.strictEqual(set.objects[0].name, 'МК_ОчередьОбработкиДополнительнойИнформации');
    assert.deepStrictEqual(set.objects[0].parts, ['RecordSetModule']);
    assert.deepStrictEqual(set.objects[1].parts, []);
  });

  test('образец побайтно совпадает с файлом пилота, если он есть на машине (tmp/ не в git)', function () {
    const sample = path.resolve(__dirname, '../../../tmp/changes.txt');
    if (!fs.existsSync(sample)) {
      this.skip();
    }
    assert.deepStrictEqual([...fs.readFileSync(sample)], [...Buffer.from(REAL_SAMPLE, 'utf-8')]);
  });

  test('разбор из реальных БАЙТОВ образца (UTF-8 BOM + CRLF), как их читает движок', () => {
    const bytes = Buffer.from(REAL_SAMPLE, 'utf-8');
    assert.deepStrictEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const set = parseDumpChanges(bytes.toString('utf-8'));
    assert.strictEqual(set.kind, 'objects');
  });

  test('Path с частями разной глубины (наблюдённые пути §5b п.8)', () => {
    const text = [
      'Modified: Document.Заказ',
      'Modified: Document.Заказ.ObjectModule',
      'New: Document.Заказ.Form.Форма',
      'Modified: Document.Заказ.Form.Форма.Form',
      'New: Document.Заказ.Template.Макет',
      'Modified: Role.Админ.Rights',
      'Modified: Configuration.Конфигурация',
      'New: Language.Русский',
      'Modified: Catalog.Товары',
    ].join('\r\n');
    const set = parseDumpChanges(`${BOM}${text}\r\n`);
    assert.ok(set.kind === 'objects');
    assert.deepStrictEqual(set.objects.map((o) => [o.change, o.kind, o.name, o.parts]), [
      ['modified', 'Document', 'Заказ', []],
      ['modified', 'Document', 'Заказ', ['ObjectModule']],
      ['added', 'Document', 'Заказ', ['Form', 'Форма']],
      ['modified', 'Document', 'Заказ', ['Form', 'Форма', 'Form']],
      ['added', 'Document', 'Заказ', ['Template', 'Макет']],
      ['modified', 'Role', 'Админ', ['Rights']],
      ['modified', 'Configuration', 'Конфигурация', []],
      ['added', 'Language', 'Русский', []],
      ['modified', 'Catalog', 'Товары', []],
    ]);
    assert.strictEqual(set.objects[3].fullName, 'Document.Заказ.Form.Форма.Form');
  });

  test('«нет изменений» — файл из одного BOM: kind objects с пустым списком (а не unrecognized)', () => {
    assert.deepStrictEqual(parseDumpChanges(BOM), { kind: 'objects', objects: [] });
  });

  test('BOM без CRLF и пустые строки/хвостовые пробелы не мешают; LF вместо CRLF принимается', () => {
    const set = parseDumpChanges(BOM + '\nNew: Catalog.А  \n\n   \nModified: Catalog.Б\n');
    assert.deepStrictEqual(objects(set), [
      { change: 'added', fullName: 'Catalog.А' },
      { change: 'modified', fullName: 'Catalog.Б' },
    ]);
  });

  test('файл без BOM тоже разбирается (BOM необязателен), но полностью пустая строка — unrecognized: агент всегда пишет BOM', () => {
    assert.strictEqual(parseDumpChanges('Modified: Catalog.А\r\n').kind, 'objects');
    assert.strictEqual(parseDumpChanges('').kind, 'unrecognized');
  });

  test('FullDump: файл из одной строки → fullDump (с BOM и CRLF, без них, с пробелами вокруг)', () => {
    assert.deepStrictEqual(parseDumpChanges(BOM + 'FullDump\r\n'), { kind: 'fullDump' });
    assert.deepStrictEqual(parseDumpChanges('FullDump'), { kind: 'fullDump' });
    assert.deepStrictEqual(parseDumpChanges(BOM + '  FullDump  \n'), { kind: 'fullDump' });
  });

  test('FullDump вместе с другими строками — неразборчиво (так агент не пишет) → unrecognized', () => {
    assert.strictEqual(parseDumpChanges(BOM + 'FullDump\r\nModified: Catalog.А\r\n').kind, 'unrecognized');
    assert.strictEqual(parseDumpChanges(BOM + 'Modified: Catalog.А\r\nFullDump\r\n').kind, 'unrecognized');
  });

  test('неподтверждённые значения Change (Deleted, Removed, Added, регистр) → unrecognized ЦЕЛИКОМ, даже если остальные строки верны', () => {
    for (const change of ['Deleted', 'Removed', 'Added', 'new', 'MODIFIED', 'Renamed', '']) {
      const set = parseDumpChanges(`${BOM}Modified: Catalog.А\r\n${change}: Catalog.Б\r\n`);
      assert.strictEqual(set.kind, 'unrecognized', `Change="${change}"`);
    }
  });

  test('мусор → unrecognized с причиной', () => {
    const garbage = [
      'просто текст',
      '<xml/>',
      'New Catalog.А',          // нет двоеточия
      'New:',                   // нет пути
      'New: ',                  // пустой путь
      'New: Catalog',           // нет имени
      'New: Catalog.',          // пустое имя
      'New: .Имя',              // пустой вид
      'New: Catalog..Часть',    // пустой сегмент
      'New: Catalog.А.',        // пустой хвостовой сегмент
      'New: Catalog.А Б',       // пробел внутри пути
      'New: Catalog.А: лишнее', // двоеточие внутри
      '\u0000\u0001',
    ];
    for (const line of garbage) {
      const set = parseDumpChanges(`${BOM}${line}\r\n`);
      assert.ok(set.kind === 'unrecognized', `строка "${line}": ${set.kind}`);
      assert.ok(set.reason.length > 0);
    }
  });

  test('Path — не более пяти сегментов (Kind.Name.PartKind.PartName.SubPart); шесть и больше — неразборчиво', () => {
    assert.strictEqual(parseDumpChanges(BOM + 'Modified: Document.А.Form.Б.Form\r\n').kind, 'objects');
    assert.strictEqual(parseDumpChanges(BOM + 'Modified: Document.А.Form.Б.Form.Command\r\n').kind, 'unrecognized');
  });

  test('дубликаты строк сохраняются как есть (дедупликация — на стороне ChangedObjectFiles)', () => {
    const set = parseDumpChanges(BOM + 'Modified: Catalog.А\r\nModified: Catalog.А\r\n');
    assert.ok(set.kind === 'objects');
    assert.strictEqual(set.objects.length, 2);
  });
});
