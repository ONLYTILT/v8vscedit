import * as assert from 'assert';
import {
  buildAddUserOperation,
  buildBindOperation,
  buildCopyUsersOperation,
  buildCreateOperation,
  buildDumpOperation,
  buildReportOperation,
  buildSetLabelOperation,
  normalizeUpdateVersion,
  reportDefaultExtension,
  sanitizeFileName,
  validateBindingForm,
  type RepositoryReportFlag,
} from '../../ui/commands/repository/repositoryOperationBuilders';
import { buildRepositoryDesignerRequest } from '../../infra/repository/RepositoryDesignerArgs';

const CONNECTION = { infoBasePath: 'C:\\base' };
const BINDING = { repoPath: 'repo', repoUser: 'u', repoPassword: '' };

function vector(op: Parameters<typeof buildRepositoryDesignerRequest>[2]): string[] {
  return buildRepositoryDesignerRequest(CONNECTION, BINDING, op).args.filter((a): a is string => typeof a === 'string');
}

suite('repositoryOperationBuilders', () => {
  test('buildBindOperation', () => {
    assert.deepStrictEqual(buildBindOperation({ forceReplaceCfg: true }), {
      kind: 'bind', forceBindAlreadyBindedUser: undefined, forceReplaceCfg: true,
    });
    assert.ok(vector(buildBindOperation({ forceBindAlreadyBindedUser: true })).includes('-forceBindAlreadyBindedUser'));
  });

  test('buildCreateOperation', () => {
    const op = buildCreateOperation({
      allowConfigurationChanges: true, changesAllowedRule: 'a', changesNotRecommendedRule: 'b', noBind: true,
    });
    assert.deepStrictEqual(op, {
      kind: 'create', allowConfigurationChanges: true, changesAllowedRule: 'a', changesNotRecommendedRule: 'b', noBind: true,
    });
    const args = vector(op);
    for (const key of ['-AllowConfigurationChanges', '-ChangesAllowedRule', '-ChangesNotRecommendedRule', '-NoBind']) {
      assert.ok(args.includes(key), key);
    }
  });

  test('buildAddUserOperation и buildCopyUsersOperation', () => {
    assert.deepStrictEqual(
      buildAddUserOperation({ user: 'u', password: 'p', rights: 'ReadOnly', restoreDeletedUser: true }),
      { kind: 'addUser', user: 'u', password: 'p', rights: 'ReadOnly', restoreDeletedUser: true }
    );
    assert.deepStrictEqual(
      buildCopyUsersOperation({ path: 'src', user: 'u', password: 'p', restoreDeletedUser: false }),
      { kind: 'copyUsers', path: 'src', user: 'u', password: 'p', restoreDeletedUser: false }
    );
  });

  test('buildDumpOperation обрезает версию; пустая не попадает в вектор', () => {
    assert.deepStrictEqual(buildDumpOperation('  12 '), { kind: 'dump', version: '12' });
    assert.ok(!vector(buildDumpOperation('  ')).includes('-v'));
  });

  test('normalizeUpdateVersion', () => {
    assert.strictEqual(normalizeUpdateVersion(''), undefined);
    assert.strictEqual(normalizeUpdateVersion('   '), undefined);
    assert.strictEqual(normalizeUpdateVersion(' 7 '), '7');
  });

  const FLAG_FIELDS: readonly [RepositoryReportFlag, string][] = [
    ['GroupByObject', 'groupByObject'],
    ['GroupByComment', 'groupByComment'],
    ['DoNotIncludeVersionsWithLabels', 'doNotIncludeVersionsWithLabels'],
    ['IncludeOnlyVersionsWithLabels', 'includeOnlyVersionsWithLabels'],
    ['IncludeCommentLinesWithDoubleSlash', 'includeCommentLinesWithDoubleSlash'],
  ];
  const base = { nBegin: ' 1 ', nEnd: ' 2 ', dateBegin: ' d1 ', dateEnd: ' d2 ', configurationVersion: ' v ' };

  for (const [flag, field] of FLAG_FIELDS) {
    test(`buildReportOperation: флаг ${flag} включён только сам`, () => {
      const on = buildReportOperation({ ...base, format: 'txt', flags: [flag] }) as unknown as Record<string, unknown>;
      const off = buildReportOperation({ ...base, format: 'txt', flags: [] }) as unknown as Record<string, unknown>;
      assert.strictEqual(on[field], true);
      assert.strictEqual(off[field], false);
      for (const [, other] of FLAG_FIELDS) {
        if (other !== field) {
          assert.strictEqual(on[other], false);
        }
      }
    });
  }

  test('buildReportOperation: строки обрезаются, формат сохраняется', () => {
    for (const format of ['txt', 'mxl'] as const) {
      assert.deepStrictEqual(buildReportOperation({ ...base, format, flags: [] }), {
        kind: 'report', nBegin: '1', nEnd: '2', dateBegin: 'd1', dateEnd: 'd2', configurationVersion: 'v',
        reportFormat: format, groupByObject: false, groupByComment: false,
        doNotIncludeVersionsWithLabels: false, includeOnlyVersionsWithLabels: false,
        includeCommentLinesWithDoubleSlash: false,
      });
    }
  });

  test('reportDefaultExtension', () => {
    assert.strictEqual(reportDefaultExtension('mxl'), 'mxl');
    assert.strictEqual(reportDefaultExtension('txt'), 'txt');
  });

  test('buildSetLabelOperation: имя как есть, остальное обрезается', () => {
    assert.deepStrictEqual(buildSetLabelOperation({ name: ' М ', version: ' 3 ', comment: ' к ' }), {
      kind: 'setLabel', name: ' М ', version: '3', comment: 'к',
    });
  });

  test('validateBindingForm', () => {
    assert.deepStrictEqual(validateBindingForm({ repoPath: '  ', repoUser: 'u', repoPassword: '' }), {
      ok: false, errorMessage: 'Нужно указать путь к хранилищу или адрес сервера.',
    });
    assert.deepStrictEqual(validateBindingForm({ repoPath: 'p', repoUser: ' ', repoPassword: '' }), {
      ok: false, errorMessage: 'Нужно указать пользователя хранилища.',
    });
    assert.deepStrictEqual(validateBindingForm({ repoPath: ' p ', repoUser: ' u ', repoPassword: ' pw ' }), {
      ok: true, binding: { repoPath: 'p', repoUser: 'u', repoPassword: ' pw ' },
    });
  });

  for (const ch of ['\\', '/', ':', '*', '?', '"', '<', '>', '|']) {
    test(`sanitizeFileName заменяет «${ch}»`, () => {
      assert.strictEqual(sanitizeFileName(`a${ch}b`), 'a_b');
    });
  }
  test('sanitizeFileName не трогает обычные символы', () => {
    assert.strictEqual(sanitizeFileName('Справочник.Товары'), 'Справочник.Товары');
  });
});
