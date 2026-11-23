import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Защита от повторения дефекта прокрутки «Показать в дереве метаданных».
 *
 * Webview навигатора получает сообщения хоста через `MessageBus`, а шина вызывает
 * обработчик только для типов, на которые он подписан (`messageBus.on(<тип>, …)`).
 * Ветка `msg.type === 'revealSelected'` в обработчике была, подписки — нет: хост слал
 * сообщение, шина его молча отбрасывала, и прокрутки не было, хотя все тесты хоста
 * (они видят только отправленные сообщения) были зелёными. Связь проходит через
 * границу сборки, тайпчек её не видит — поэтому сверка по исходникам.
 */

const ROOT = path.resolve(__dirname, '../../..');
const UNIVERSAL_APP_VUE = path.join(ROOT, 'src-ui/apps/universal/UniversalApp.vue');
const UNIVERSAL_PROVIDER_TS = path.join(ROOT, 'src/ui/views/universal/UniversalPanelViewProvider.ts');

function readSource(file: string): string {
  assert.ok(fs.existsSync(file), `файл не найден: ${file} — перенесён? обновите путь в тесте вместе с переносом`);
  return fs.readFileSync(file, 'utf-8');
}

function matchesOf(source: string, pattern: RegExp): Set<string> {
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

suite('Навигатор: типы сообщений хоста ↔ подписки webview', () => {
  const vue = readSource(UNIVERSAL_APP_VUE);
  const subscribed = matchesOf(vue, /messageBus\.on\('(\w+)'/g);
  const unsubscribed = matchesOf(vue, /messageBus\.off\('(\w+)'/g);

  test('каждый тип, разбираемый обработчиком, подписан в шине', () => {
    const handled = matchesOf(vue, /msg\.type === '(\w+)'/g);
    assert.ok(handled.has('revealSelected'), 'обработчик прокрутки не найден — тест устарел');
    assert.deepStrictEqual([...handled].filter((type) => !subscribed.has(type)), []);
  });

  test('каждый тип, который шлёт хост, подписан в шине', () => {
    const posted = matchesOf(readSource(UNIVERSAL_PROVIDER_TS), /\btype: '(\w+)'(?=\s*[,}])/g);
    assert.ok(posted.has('revealSelected') && posted.has('state'), `не разобраны отправки хоста: ${[...posted].join(', ')}`);
    assert.deepStrictEqual([...posted].filter((type) => !subscribed.has(type)), []);
  });

  test('подписки снимаются при размонтировании симметрично', () => {
    assert.deepStrictEqual([...subscribed].sort(), [...unsubscribed].sort());
  });
});
