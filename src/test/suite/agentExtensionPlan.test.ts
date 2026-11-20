/**
 * Чистые решения поверх списка расширений базы (domain/agent/AgentExtensionPlan.ts), ФАКТ Э29:
 *  - заглушка в имени загрузки — НЕ отказ: «load → update → сверка списком» (П3);
 *  - выгрузка заглушки роняет агента — отказ E3;
 *  - имя после применения берётся из файла: сверка нужна и для новых, и для существующих (П4).
 * Имена 1С сравниваются без учёта регистра.
 */
import * as assert from 'assert';
import {
  hasExtension,
  planCfeDumpTarget,
  planCfeLoadTarget,
  splitDumpableExtensions,
  verifyNewExtensionLoad,
  type AgentExtensionInfo,
} from '../../domain/agent';

const ZERO = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const applied = (name: string): AgentExtensionInfo => ({ name, hashSum: `h-${name}` });
const stub = (name: string): AgentExtensionInfo => ({ name, hashSum: ZERO });

suite('planCfeLoadTarget', () => {
  test('имени нет в базе → new (после load-cfg обязателен update-db-cfg)', () => {
    assert.deepStrictEqual(planCfeLoadTarget([applied('A')], 'B'), { kind: 'new' });
  });

  test('пустая база → new', () => {
    assert.deepStrictEqual(planCfeLoadTarget([], 'B'), { kind: 'new' });
  });

  test('есть, другой регистр → existing с регистром базы', () => {
    assert.deepStrictEqual(planCfeLoadTarget([applied('РасШ')], 'расш'), { kind: 'existing', name: 'РасШ' });
  });

  test('заглушка в имени — НЕ refuse (Э29 П3): решение несёт имя из базы', () => {
    const decision = planCfeLoadTarget([stub('Расш')], 'расш');
    assert.notStrictEqual(decision.kind, 'refuse');
    assert.notStrictEqual(decision.kind, 'new', 'запись в базе уже есть — это не новое имя');
    assert.strictEqual((decision as { name?: string }).name, 'Расш');
  });
});

suite('planCfeDumpTarget', () => {
  test('есть в базе → dump с именем в регистре базы', () => {
    assert.deepStrictEqual(planCfeDumpTarget([applied('РасШ')], 'расш'), { kind: 'dump', name: 'РасШ' });
  });

  test('нет в базе → refuse E5 со списком расширений базы', () => {
    const decision = planCfeDumpTarget([applied('A'), applied('B')], 'X');
    assert.strictEqual(decision.kind, 'refuse');
    const reason = (decision as { reason: string }).reason;
    assert.ok(reason.includes('«X»') && reason.includes('нет в базе'), reason);
    assert.ok(reason.includes('A, B'), reason);
  });

  test('нет в базе и база пуста → refuse E5 «в базе нет расширений»', () => {
    const decision = planCfeDumpTarget([], 'X');
    assert.strictEqual(decision.kind, 'refuse');
    assert.ok((decision as { reason: string }).reason.includes('в базе нет расширений'));
  });

  test('заглушка → refuse E3 (выгрузка заглушки роняет агента)', () => {
    const decision = planCfeDumpTarget([stub('X')], 'x');
    assert.strictEqual(decision.kind, 'refuse');
    const reason = (decision as { reason: string }).reason;
    assert.ok(reason.includes('«X»') && reason.includes('не применено') && reason.includes('выгружать нельзя'), reason);
  });
});

suite('splitDumpableExtensions', () => {
  test('смесь: применённые — в dumpable, заглушки — в stubs, порядок входа сохраняется', () => {
    assert.deepStrictEqual(
      splitDumpableExtensions([applied('B'), stub('S1'), applied('A'), stub('S2')]),
      { dumpable: ['B', 'A'], stubs: ['S1', 'S2'] }
    );
  });

  test('пустой список', () => {
    assert.deepStrictEqual(splitDumpableExtensions([]), { dumpable: [], stubs: [] });
  });
});

suite('verifyNewExtensionLoad', () => {
  test('ok: запрошенное имя появилось применённым', () => {
    assert.deepStrictEqual(
      verifyNewExtensionLoad([applied('A')], [applied('A'), applied('X')], 'X'),
      { status: 'ok', actualName: 'X' }
    );
  });

  test('ok: регистр имени берётся из базы', () => {
    assert.deepStrictEqual(
      verifyNewExtensionLoad([], [applied('РасШ')], 'расш'),
      { status: 'ok', actualName: 'РасШ' }
    );
  });

  test('renamed: появилось одно другое имя (Э29: имя взято из файла)', () => {
    assert.deepStrictEqual(
      verifyNewExtensionLoad([applied('A')], [applied('A'), applied('Z')], 'X'),
      { status: 'renamed', actualName: 'Z' }
    );
  });

  test('stub: запрошенное имя появилось, но осталось заглушкой', () => {
    assert.deepStrictEqual(
      verifyNewExtensionLoad([applied('A')], [applied('A'), stub('X')], 'X'),
      { status: 'stub', actualName: 'X' }
    );
  });

  test('missing: ничего нового не появилось', () => {
    assert.deepStrictEqual(verifyNewExtensionLoad([applied('A')], [applied('A')], 'X'), { status: 'missing' });
  });

  test('несколько новых имён, среди них запрошенное → выбирается запрошенное', () => {
    assert.deepStrictEqual(
      verifyNewExtensionLoad([], [applied('Z'), applied('X'), applied('Y')], 'X'),
      { status: 'ok', actualName: 'X' }
    );
  });

  test('несколько новых имён без запрошенного → missing (неоднозначно, угадывать нельзя)', () => {
    assert.deepStrictEqual(
      verifyNewExtensionLoad([], [applied('Z'), applied('Y')], 'X'),
      { status: 'missing' }
    );
  });

  test('старые имена не считаются «появившимися»: заглушка, бывшая до загрузки, не маскирует отсутствие', () => {
    assert.deepStrictEqual(verifyNewExtensionLoad([stub('S')], [stub('S')], 'X'), { status: 'missing' });
  });
});

suite('hasExtension', () => {
  test('регистронезависимо', () => {
    assert.strictEqual(hasExtension([applied('РасШ')], 'расш'), true);
  });

  test('заглушка — есть', () => {
    assert.strictEqual(hasExtension([stub('X')], 'X'), true);
  });

  test('нет в списке и пустой список', () => {
    assert.strictEqual(hasExtension([applied('A')], 'X'), false);
    assert.strictEqual(hasExtension([], 'X'), false);
  });
});
