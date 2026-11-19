import * as assert from 'assert';
import { encode } from 'iconv-lite';
import { decodeDesignerLogBytes } from '../../infra/process/OutputDecoder';

/**
 * Лог `/Out` пакетного конфигуратора пишется платформой в кодировке, которую
 * заранее не знаем: UTF-16 с BOM (обе очерёдности), UTF-8 с BOM или BOM-less
 * OEM-866/Win1251. Декодер не должен зависеть от ОС теста (в отличие от
 * `decodeProcessOutput`), поэтому проверяется чистая функция по байтам.
 */
suite('decodeDesignerLogBytes', () => {
  const TEXT = 'Ошибка: объект захвачен пользователем Иванов';

  test('пустой буфер даёт пустую строку', () => {
    assert.strictEqual(decodeDesignerLogBytes(Buffer.alloc(0)), '');
  });

  test('UTF-16LE с BOM: BOM отбрасывается', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(TEXT, 'utf16le')]);
    assert.strictEqual(decodeDesignerLogBytes(bytes), TEXT);
  });

  test('UTF-16BE с BOM: BOM отбрасывается', () => {
    const bytes = Buffer.concat([Buffer.from([0xfe, 0xff]), encode(TEXT, 'utf16-be')]);
    assert.strictEqual(decodeDesignerLogBytes(bytes), TEXT);
  });

  test('UTF-8 с BOM: BOM отбрасывается', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, 'utf-8')]);
    assert.strictEqual(decodeDesignerLogBytes(bytes), TEXT);
  });

  test('UTF-8 без BOM и без повреждённых символов возвращается как есть', () => {
    assert.strictEqual(decodeDesignerLogBytes(Buffer.from(TEXT, 'utf-8')), TEXT);
  });

  test('чистый ASCII без BOM возвращается как есть', () => {
    assert.strictEqual(decodeDesignerLogBytes(Buffer.from('Done.\r\nOK', 'utf-8')), 'Done.\r\nOK');
  });

  test('без BOM, Win1251: эвристика выбирает cp1251', () => {
    assert.strictEqual(decodeDesignerLogBytes(encode(TEXT, 'win1251')), TEXT);
  });

  test('без BOM, OEM-866: эвристика выбирает cp866', () => {
    assert.strictEqual(decodeDesignerLogBytes(encode(TEXT, 'cp866')), TEXT);
  });

  // Граница BOM: один байт 0xFF не образует BOM UTF-16LE и не должен срезаться.
  test('одиночный байт 0xFF не принимается за BOM', () => {
    const decoded = decodeDesignerLogBytes(Buffer.from([0xff]));
    assert.ok(decoded.length > 0, 'байт не должен пропасть');
  });

  test('только BOM UTF-16LE без данных даёт пустую строку', () => {
    assert.strictEqual(decodeDesignerLogBytes(Buffer.from([0xff, 0xfe])), '');
  });
});
