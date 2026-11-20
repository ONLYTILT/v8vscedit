/**
 * Тесты хранилища событий MCP-сессии (`src/infra/mcp/McpSessionEventStore.ts`, контракт плана 1.3):
 * основа возобновляемости SSE (`Last-Event-ID`). Время — внедрённые часы, без реальных таймеров:
 * очистка ленивая (на `storeEvent`/`replayEventsAfter`).
 */
import * as assert from 'assert';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  DEFAULT_MCP_EVENT_STORE_LIMITS,
  MCP_SSE_RETRY_INTERVAL_MS,
  McpSessionEventStore,
  formatEventId,
  parseEventId,
  type McpEventStoreLimits,
} from '../../infra/mcp/McpSessionEventStore';

const note = (tag: string, pad = ''): JSONRPCMessage => ({
  jsonrpc: '2.0', method: 'notifications/progress', params: { tag, pad },
});
const response = (id: number, pad = ''): JSONRPCMessage => ({ jsonrpc: '2.0', id, result: { pad } });
const errorResponse = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, error: { code: -32000, message: 'отказ' } });
const request = (id: number): JSONRPCMessage => ({ jsonrpc: '2.0', id, method: 'tools/call', params: {} });
const sizeOf = (message: JSONRPCMessage): number => JSON.stringify(message).length;
const tagOf = (message: JSONRPCMessage): unknown => (message as { params?: { tag?: unknown } }).params?.tag;

interface Replayed {
  readonly streamId: string;
  readonly got: { id: string; message: JSONRPCMessage }[];
}

async function replay(store: McpSessionEventStore, lastEventId: string): Promise<Replayed> {
  const got: { id: string; message: JSONRPCMessage }[] = [];
  const streamId = await store.replayEventsAfter(lastEventId, {
    send: (id, message) => { got.push({ id, message }); return Promise.resolve(); },
  });
  return { streamId, got };
}

const BIG: McpEventStoreLimits = {
  maxEventsPerStream: 1_000_000, maxStreams: 1_000_000, maxBytes: Number.MAX_SAFE_INTEGER, completedStreamTtlMs: Number.MAX_SAFE_INTEGER,
};

suite('McpSessionEventStore — события сессии для возобновления SSE', () => {
  let clock: number;
  const now = (): number => clock;
  const make = (limits: Partial<McpEventStoreLimits> = {}): McpSessionEventStore =>
    new McpSessionEventStore({ ...BIG, ...limits }, now);

  setup(() => { clock = 0; });

  suite('константы и идентификаторы событий', () => {
    test('интервал повтора SSE — 1000 мс; лимиты по умолчанию: 1000 событий/поток, 64 потока, 16 МиБ, TTL завершённого потока 15 мин', () => {
      assert.strictEqual(MCP_SSE_RETRY_INTERVAL_MS, 1_000);
      assert.deepStrictEqual(DEFAULT_MCP_EVENT_STORE_LIMITS, {
        maxEventsPerStream: 1000, maxStreams: 64, maxBytes: 16 * 1024 * 1024, completedStreamTtlMs: 15 * 60_000,
      });
    });

    test('формат id события: «<streamId>:<seq>»', () => {
      assert.strictEqual(formatEventId('поток-1', 42), 'поток-1:42');
    });

    const VALID: readonly { id: string; streamId: string; seq: number }[] = [
      { id: 'abc:0', streamId: 'abc', seq: 0 },
      { id: 'abc:17', streamId: 'abc', seq: 17 },
      { id: '_GET_stream:5', streamId: '_GET_stream', seq: 5 },
      { id: 'a:b:c:9', streamId: 'a:b:c', seq: 9 },
    ];
    for (const { id, streamId, seq } of VALID) {
      test(`parseEventId «${id}» → ${streamId} / ${String(seq)} (разделитель — последнее двоеточие)`, () => {
        assert.deepStrictEqual(parseEventId(id), { streamId, seq });
      });
    }

    const INVALID: readonly { id: string; why: string }[] = [
      { id: 'без-двоеточия', why: 'нет «:»' },
      { id: 'abc:xyz', why: 'seq не число' },
      { id: 'abc:-1', why: 'отрицательный seq' },
      { id: 'abc:1.5', why: 'дробный seq' },
      { id: 'abc:', why: 'пустой seq' },
      { id: ':5', why: 'пустой streamId' },
      { id: '', why: 'пустая строка' },
    ];
    for (const { id, why } of INVALID) {
      test(`parseEventId «${id}» → undefined (${why})`, () => {
        assert.strictEqual(parseEventId(id), undefined);
      });
    }

    test('formatEventId и parseEventId взаимно обратны', () => {
      assert.deepStrictEqual(parseEventId(formatEventId('s:t', 3)), { streamId: 's:t', seq: 3 });
    });
  });

  suite('storeEvent и replayEventsAfter', () => {
    test('storeEvent возвращает id вида «<поток>:<seq>»; seq строго растёт по всему хранилищу, а не по потоку', async () => {
      const store = make();
      const a1 = parseEventId(await store.storeEvent('A', note('a1')));
      const b1 = parseEventId(await store.storeEvent('B', note('b1')));
      const a2 = parseEventId(await store.storeEvent('A', note('a2')));
      assert.ok(a1 && b1 && a2);
      assert.deepStrictEqual([a1.streamId, b1.streamId, a2.streamId], ['A', 'B', 'A']);
      assert.ok(a1.seq < b1.seq && b1.seq < a2.seq, `${String(a1.seq)} < ${String(b1.seq)} < ${String(a2.seq)}`);
    });

    test('replay при чередовании потоков отдаёт только события СВОЕГО потока после указанного, по порядку; возвращает streamId', async () => {
      const store = make();
      const a1 = await store.storeEvent('A', note('a1'));
      const b1 = await store.storeEvent('B', note('b1'));
      const a2 = await store.storeEvent('A', note('a2'));
      const b2 = await store.storeEvent('B', note('b2'));
      const a3 = await store.storeEvent('A', note('a3'));

      const afterA1 = await replay(store, a1);
      assert.strictEqual(afterA1.streamId, 'A');
      assert.deepStrictEqual(afterA1.got.map((e) => [e.id, tagOf(e.message)]), [[a2, 'a2'], [a3, 'a3']]);

      const afterB1 = await replay(store, b1);
      assert.strictEqual(afterB1.streamId, 'B');
      assert.deepStrictEqual(afterB1.got.map((e) => [e.id, tagOf(e.message)]), [[b2, 'b2']]);
    });

    test('priming «{}» не JSON-RPC: при replay пропускается (клиент не получает мусор вместо сообщения)', async () => {
      const store = make();
      const priming = await store.storeEvent('A', {} as JSONRPCMessage);
      const a1 = await store.storeEvent('A', note('a1'));
      await store.storeEvent('A', {} as JSONRPCMessage);
      await store.storeEvent('A', note('a2'));

      const fromPriming = await replay(store, priming);
      assert.deepStrictEqual(fromPriming.got.map((e) => tagOf(e.message)), ['a1', 'a2']);
      const fromA1 = await replay(store, a1);
      assert.deepStrictEqual(fromA1.got.map((e) => tagOf(e.message)), ['a2']);
    });

    test('replay после последнего события: ничего не отправляется, streamId возвращается', async () => {
      const store = make();
      await store.storeEvent('A', note('a1'));
      const last = await store.storeEvent('A', note('a2'));
      const result = await replay(store, last);
      assert.strictEqual(result.streamId, 'A');
      assert.deepStrictEqual(result.got, []);
    });

    test('replay сообщения-ответа сохраняет его содержимое как есть', async () => {
      const store = make();
      const first = await store.storeEvent('A', note('a1'));
      await store.storeEvent('A', response(7, 'итог'));
      const result = await replay(store, first);
      assert.deepStrictEqual(result.got.map((e) => e.message), [response(7, 'итог')]);
    });

    const BAD_IDS = ['мусор', 'A:xyz', 'A:-3', ':4'];
    for (const id of BAD_IDS) {
      test(`невалидный id «${id}» → Error`, async () => {
        const store = make();
        await store.storeEvent('A', note('a1'));
        await assert.rejects(() => replay(store, id), (error: unknown) => error instanceof Error);
      });
    }

    test('неизвестный поток → Error', async () => {
      const store = make();
      await store.storeEvent('A', note('a1'));
      await assert.rejects(() => replay(store, 'нет-такого:3'), (error: unknown) => error instanceof Error);
    });

    test('вытесненный поток → Error (как неизвестный)', async () => {
      const store = make({ maxStreams: 1 });
      const a1 = await store.storeEvent('A', note('a1'));
      await store.storeEvent('B', note('b1'));
      await assert.rejects(() => replay(store, a1), (error: unknown) => error instanceof Error);
    });

    test('getStreamIdForEventId НЕ реализован (ловушка 409: устаревшая запись оборванного replay-потока даёт Conflict)', () => {
      const store = make() as unknown as Record<string, unknown>;
      assert.strictEqual('getStreamIdForEventId' in store, false);
      assert.strictEqual(store.getStreamIdForEventId, undefined);
    });
  });

  suite('статистика и clear', () => {
    test('stats: потоки, события и байты (размер — длина JSON-строки сообщения, включая priming «{}»)', async () => {
      const store = make();
      assert.deepStrictEqual(store.stats(), { streams: 0, events: 0, bytes: 0 });
      const messages = [{} as JSONRPCMessage, note('a1'), response(1, 'x')];
      await store.storeEvent('A', messages[0]);
      await store.storeEvent('A', messages[1]);
      await store.storeEvent('B', messages[2]);
      assert.deepStrictEqual(store.stats(), {
        streams: 2, events: 3, bytes: messages.reduce((sum, message) => sum + sizeOf(message), 0),
      });
    });

    test('clear: всё забыто, replay прежнего id — Error', async () => {
      const store = make();
      const a1 = await store.storeEvent('A', note('a1'));
      await store.storeEvent('B', note('b1'));
      store.clear();
      assert.deepStrictEqual(store.stats(), { streams: 0, events: 0, bytes: 0 });
      await assert.rejects(() => replay(store, a1), (error: unknown) => error instanceof Error);
    });

    test('после clear хранилище работоспособно', async () => {
      const store = make();
      await store.storeEvent('A', note('a1'));
      store.clear();
      const id = await store.storeEvent('A', note('a2'));
      assert.deepStrictEqual((await replay(store, id)).got, []);
      assert.strictEqual(store.stats().streams, 1);
    });
  });

  suite('TTL завершённых потоков', () => {
    const TTL = 1_000;

    const COMPLETED: readonly { title: string; message: JSONRPCMessage; completes: boolean }[] = [
      { title: 'ответ с result завершает поток', message: response(1), completes: true },
      { title: 'ответ с error завершает поток', message: errorResponse(1), completes: true },
      { title: 'запрос (id + method) поток НЕ завершает', message: request(1), completes: false },
      { title: 'уведомление поток НЕ завершает', message: note('n'), completes: false },
    ];
    for (const { title, message, completes } of COMPLETED) {
      test(`${title}: через TTL+1 мс ${completes ? 'поток удаляется' : 'поток остаётся'}`, async () => {
        const store = make({ completedStreamTtlMs: TTL });
        const first = await store.storeEvent('A', note('начало'));
        await store.storeEvent('A', message);
        clock += TTL + 1;
        await store.storeEvent('B', note('b'));
        assert.strictEqual(store.stats().streams, completes ? 1 : 2);
        if (completes) {
          await assert.rejects(() => replay(store, first), (error: unknown) => error instanceof Error);
        } else {
          assert.strictEqual((await replay(store, first)).streamId, 'A');
        }
      });
    }

    test('граница: ровно TTL мс после завершения поток ещё жив (удаление — строго позже)', async () => {
      const store = make({ completedStreamTtlMs: TTL });
      const first = await store.storeEvent('A', note('a1'));
      await store.storeEvent('A', response(1));
      clock += TTL;
      await store.storeEvent('B', note('b1'));
      assert.strictEqual((await replay(store, first)).streamId, 'A');
    });

    test('TTL отсчитывается от завершения, а не от создания потока', async () => {
      const store = make({ completedStreamTtlMs: TTL });
      const first = await store.storeEvent('A', note('a1'));
      clock += TTL * 5;
      await store.storeEvent('A', response(1));
      clock += TTL - 1;
      await store.storeEvent('B', note('b'));
      assert.strictEqual((await replay(store, first)).streamId, 'A');
    });

    test('очистку запускает и replay: завершённый поток с истёкшим TTL исчезает при replay другого потока', async () => {
      const store = make({ completedStreamTtlMs: TTL });
      await store.storeEvent('A', response(1));
      const b1 = await store.storeEvent('B', note('b1'));
      clock += TTL + 1;
      await replay(store, b1);
      assert.strictEqual(store.stats().streams, 1);
    });

    test('replay самого просроченного завершённого потока → Error (очистка идёт до поиска потока)', async () => {
      const store = make({ completedStreamTtlMs: TTL });
      const a1 = await store.storeEvent('A', note('a1'));
      await store.storeEvent('A', response(1));
      clock += TTL + 1;
      await assert.rejects(() => replay(store, a1), (error: unknown) => error instanceof Error);
    });

    test('открытый (без ответа) поток по TTL не истекает, как бы стар ни был', async () => {
      const store = make({ completedStreamTtlMs: TTL });
      const a1 = await store.storeEvent('A', note('a1'));
      clock += TTL * 1_000;
      await store.storeEvent('B', note('b1'));
      assert.strictEqual((await replay(store, a1)).streamId, 'A');
    });
  });

  suite('лимит потоков (maxStreams)', () => {
    test('сверх лимита вытесняется самый старый по активности; новый поток остаётся', async () => {
      const store = make({ maxStreams: 2 });
      const a1 = await store.storeEvent('A', note('a1')); clock += 1;
      const b1 = await store.storeEvent('B', note('b1')); clock += 1;
      const c1 = await store.storeEvent('C', note('c1'));
      assert.strictEqual(store.stats().streams, 2);
      await assert.rejects(() => replay(store, a1), (error: unknown) => error instanceof Error);
      assert.strictEqual((await replay(store, b1)).streamId, 'B');
      assert.strictEqual((await replay(store, c1)).streamId, 'C');
    });

    test('завершённые потоки вытесняются первыми — даже если открытый старше', async () => {
      const store = make({ maxStreams: 2 });
      const a1 = await store.storeEvent('A', note('a1')); clock += 1;
      const b1 = await store.storeEvent('B', note('b1'));
      await store.storeEvent('B', response(1)); clock += 1;
      await store.storeEvent('C', note('c1'));
      assert.strictEqual((await replay(store, a1)).streamId, 'A', 'открытый A старше, но жив');
      await assert.rejects(() => replay(store, b1), (error: unknown) => error instanceof Error);
    });

    test('активность потока обновляется записью события: свежезаписанный A переживает B', async () => {
      const store = make({ maxStreams: 2 });
      const a1 = await store.storeEvent('A', note('a1')); clock += 1;
      const b1 = await store.storeEvent('B', note('b1')); clock += 1;
      await store.storeEvent('A', note('a2')); clock += 1;
      await store.storeEvent('C', note('c1'));
      assert.strictEqual((await replay(store, a1)).streamId, 'A');
      await assert.rejects(() => replay(store, b1), (error: unknown) => error instanceof Error);
    });

    test('активность потока обновляется replay: перечитанный A переживает B', async () => {
      const store = make({ maxStreams: 2 });
      const a1 = await store.storeEvent('A', note('a1')); clock += 1;
      const b1 = await store.storeEvent('B', note('b1')); clock += 1;
      await replay(store, a1); clock += 1;
      await store.storeEvent('C', note('c1'));
      assert.strictEqual((await replay(store, a1)).streamId, 'A');
      await assert.rejects(() => replay(store, b1), (error: unknown) => error instanceof Error);
    });
  });

  suite('лимит байтов (maxBytes)', () => {
    test('сначала вытесняются завершённые потоки (целиком, вместе с ответом), открытые не страдают', async () => {
      const aNote = note('a-n', '1234567890');
      const aResponse = response(1, 'итог');
      const bNote = note('b-n', 'ab');
      const cNote = note('c-n', '1234567890'.repeat(3));
      const slack = 5;
      // Предусловия сценария: одного лишь удаления уведомления A мало (нужно убрать и ответ), а B + C влезают.
      assert.ok(sizeOf(cNote) - slack > sizeOf(aNote), 'уведомления A недостаточно для освобождения места');
      assert.ok(sizeOf(cNote) <= sizeOf(aNote) + sizeOf(aResponse) + slack, 'после удаления A поток C влезает');
      const store = make({ maxBytes: sizeOf(aNote) + sizeOf(aResponse) + sizeOf(bNote) + slack });
      const a1 = await store.storeEvent('A', aNote);
      await store.storeEvent('A', aResponse);
      await store.storeEvent('B', bNote);
      assert.strictEqual(store.stats().events, 3, 'в пределах лимита ничего не вытеснено');

      await store.storeEvent('C', cNote);
      assert.deepStrictEqual(store.stats(), { streams: 2, events: 2, bytes: sizeOf(bNote) + sizeOf(cNote) });
      await assert.rejects(() => replay(store, a1), (error: unknown) => error instanceof Error);
    });

    test('затем вытесняются старые не-ответы открытых потоков (самое старое событие первым)', async () => {
      const pad = (tag: string): JSONRPCMessage => note(tag, 'xxxxxxxxxx');
      const size = sizeOf(pad('a1'));
      const store = make({ maxBytes: size * 3 });
      const a1 = await store.storeEvent('A', pad('a1'));
      await store.storeEvent('A', pad('a2'));
      const b1 = await store.storeEvent('B', pad('b1'));
      assert.strictEqual(store.stats().events, 3);

      await store.storeEvent('B', pad('b2'));
      assert.deepStrictEqual(store.stats(), { streams: 2, events: 3, bytes: size * 3 });
      assert.deepStrictEqual((await replay(store, a1)).got.map((e) => tagOf(e.message)), ['a2'], 'a1 вытеснено, a2 цело');
      const beforeB1 = formatEventId('B', (parseEventId(b1)?.seq ?? 0) - 1);
      assert.deepStrictEqual((await replay(store, beforeB1)).got.map((e) => tagOf(e.message)), ['b1', 'b2']);
    });

    test('одиночное сообщение больше лимита всё равно хранится', async () => {
      const store = make({ maxBytes: 10 });
      const huge = note('huge', 'x'.repeat(200));
      await store.storeEvent('A', huge);
      assert.deepStrictEqual(store.stats(), { streams: 1, events: 1, bytes: sizeOf(huge) });
    });
  });

  suite('лимит событий потока (maxEventsPerStream)', () => {
    test('удаляется старейшее не-ответное событие потока', async () => {
      const store = make({ maxEventsPerStream: 2 });
      const n1 = await store.storeEvent('A', note('n1'));
      await store.storeEvent('A', note('n2'));
      await store.storeEvent('A', note('n3'));
      assert.strictEqual(store.stats().events, 2);
      assert.deepStrictEqual((await replay(store, n1)).got.map((e) => tagOf(e.message)), ['n2', 'n3']);
    });

    test('ответ не вытесняется никогда: n1, ответ, n2 → остаются ответ и n2', async () => {
      const store = make({ maxEventsPerStream: 2 });
      const n1 = await store.storeEvent('A', note('n1'));
      await store.storeEvent('A', response(9, 'итог'));
      await store.storeEvent('A', note('n2'));
      assert.strictEqual(store.stats().events, 2);
      const kept = (await replay(store, n1)).got.map((e) => e.message);
      assert.deepStrictEqual(kept, [response(9, 'итог'), note('n2')]);
    });

    test('лимит превышен, а вытеснять нечего (одни ответы): события сохраняются, цикл не зацикливается', async () => {
      const store = make({ maxEventsPerStream: 1 });
      const first = await store.storeEvent('A', response(1, 'первый'));
      await store.storeEvent('A', response(2, 'второй'));
      assert.strictEqual(store.stats().events, 2, 'ответы не вытесняются никогда, даже сверх лимита');
      assert.deepStrictEqual((await replay(store, first)).got.map((e) => e.message), [response(2, 'второй')]);
    });

    test('лимит у каждого потока свой', async () => {
      const store = make({ maxEventsPerStream: 2 });
      await store.storeEvent('A', note('a1'));
      await store.storeEvent('A', note('a2'));
      await store.storeEvent('B', note('b1'));
      await store.storeEvent('B', note('b2'));
      assert.strictEqual(store.stats().events, 4);
    });
  });

  test('конструктор без аргументов (лимиты и часы по умолчанию) работает', async () => {
    const store = new McpSessionEventStore();
    const id = await store.storeEvent('A', note('a1'));
    assert.deepStrictEqual((await replay(store, id)).got, []);
  });
});
