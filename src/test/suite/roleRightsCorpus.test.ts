import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { isAllowedRight, resolveRoleObjectName } from '../../infra/role/RoleRightsCatalog';
import { RoleRightsEditService } from '../../infra/role/RoleRightsEditService';
import { parseRightsXmlDocument } from '../../infra/xml/role/RightsXmlDocument';
import { EXAMPLE_GENERATIONS } from './support/corpus';
import { makeTempRoot, objectLines } from './support/rightsFixtures';
import { removeTreeSync } from './support/tempTree';

/**
 * Rights.xml на эталоне 2.20 (826 ролей, 426 МБ): единый проход в `suiteSetup`, точные числа
 * замеров. Правка и фильтр прав обязаны быть согласованы с реальной платформенной выгрузкой:
 * `render()` без правок возвращает файл байт-в-байт (BOM у 826 из 826, CRLF, без хвостового
 * перевода строки, `xsi:type`, сущности), все права корпуса проходят `isAllowedRight`, все
 * имена объектов проходят strict-перевод без изменений.
 *
 * Гейт на наличие — только эталон 2.20 (этим тестам 2.21 не нужен): отдельная проверка тех же
 * маркеров, что и в `REFERENCE_CORPUS_MARKERS` для 2.20; сам helper `corpus.ts` не менялся.
 */

const ROLES_DIR = path.join(EXAMPLE_GENERATIONS.cf20, 'Roles');
const CORPUS_2_20_MARKERS = [
  path.join(EXAMPLE_GENERATIONS.cf20, 'Configuration.xml'),
  path.join(EXAMPLE_GENERATIONS.cf20, 'Catalogs', 'Регионы.xml'),
  path.join(EXAMPLE_GENERATIONS.cf20, 'ExchangePlans', 'Мобильные.xml'),
  path.join(ROLES_DIR, 'Логист', 'Ext', 'Rights.xml'),
];

interface Totals {
  files: number;
  renderIdentical: number;
  xsiType: number;
  trailingNewline: number;
  bom: number;
  crlfOnly: number;
  fieldTags: number;
  fieldFiles: string[];
  emptyConditions: number;
  amp: number;
  lt: number;
  gt: number;
  objects: number;
  configurationNamed: number;
  configurationBare: number;
  configurationNames: Set<string>;
  nestedPairs: Map<string, number>;
  rootViolations: Set<string>;
  nameViolations: string[];
  parseErrors: string[];
  filesWithTemplates: string[];
  smallest: { name: string; size: number };
}

function count(text: string, token: string): number {
  let result = 0;
  let index = text.indexOf(token);
  while (index >= 0) {
    result += 1;
    index = text.indexOf(token, index + token.length);
  }
  return result;
}

function configurationNameOf(configXml: string): string {
  const match = /<Name>([^<]+)<\/Name>/.exec(configXml);
  assert.ok(match, 'в Configuration.xml есть <Name>');
  return match[1];
}

/** Замеры эталона; числа — из плана (фактически перемерены сканером независимой реализации). */
const EXPECTED = {
  files: 826,
  fieldTags: 15,
  fieldFiles: ['МК_Контрагент', 'ЧтениеИнформацииОВерсияхОбъектов'],
  emptyConditions: 1,
  amp: 139_499,
  lt: 59_573,
  gt: 36_397,
  objects: 1_101_388,
  configurationNamed: 704,
  configurationBare: 0,
  nestedPairs: {
    'Subsystem:View': 3148,
    'Attribute:View': 578_440,
    'Attribute:Edit': 611_361,
    'Command:View': 2627,
    'StandardAttribute:Edit': 237_415,
    'IntegrationServiceChannel:Use': 8,
    'TabularSection:View': 32_267,
    'TabularSection:Edit': 34_023,
    'StandardAttribute:View': 219_378,
    'Resource:Edit': 90_225,
    'Dimension:Edit': 61_334,
    'Dimension:View': 53_822,
    'Resource:View': 79_947,
    'Method:Use': 119,
    'Operation:Use': 816,
    'ExtDimensionAccountingFlag:Edit': 54,
    'StandardTabularSection:Edit': 124,
    'AccountingFlag:Edit': 72,
    'AddressingAttribute:View': 60,
    'AddressingAttribute:Edit': 60,
    'ExtDimensionAccountingFlag:View': 45,
    'StandardTabularSection:View': 121,
    'AccountingFlag:View': 60,
  },
} as const;

suite('Rights.xml: корпус', function () {
  this.timeout(600_000);
  let totals: Totals;
  let configurationName = '';
  let available = false;

  suiteSetup(function () {
    available = CORPUS_2_20_MARKERS.every((marker) => fs.existsSync(marker));
    if (!available) {
      this.skip();
    }
    configurationName = configurationNameOf(fs.readFileSync(CORPUS_2_20_MARKERS[0], 'utf-8'));
    totals = {
      files: 0, renderIdentical: 0, xsiType: 0, trailingNewline: 0, bom: 0, crlfOnly: 0, fieldTags: 0, fieldFiles: [],
      emptyConditions: 0, amp: 0, lt: 0, gt: 0, objects: 0, configurationNamed: 0, configurationBare: 0,
      configurationNames: new Set(), nestedPairs: new Map(), rootViolations: new Set(), nameViolations: [],
      parseErrors: [], filesWithTemplates: [], smallest: { name: '', size: Number.MAX_SAFE_INTEGER },
    };
    const seenNames = new Set<string>();
    for (const entry of fs.readdirSync(ROLES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const file = path.join(ROLES_DIR, entry.name, 'Ext', 'Rights.xml');
      if (!fs.existsSync(file)) {
        continue;
      }
      const raw = fs.readFileSync(file, 'utf-8');
      totals.files += 1;
      if (raw.length < totals.smallest.size) {
        totals.smallest = { name: entry.name, size: raw.length };
      }
      if (raw.slice(0, 800).includes('xsi:type="Rights"')) {
        totals.xsiType += 1;
      }
      if (raw.endsWith('\n')) {
        totals.trailingNewline += 1;
      }
      if (raw.charCodeAt(0) === 0xfeff) {
        totals.bom += 1;
      }
      if (!/(?<!\r)\n/.test(raw)) {
        totals.crlfOnly += 1;
      }
      const fields = count(raw, '<field>');
      if (fields > 0) {
        totals.fieldTags += fields;
        totals.fieldFiles.push(entry.name);
      }
      totals.emptyConditions += count(raw, '<condition/>');
      totals.amp += count(raw, '&amp;');
      totals.lt += count(raw, '&lt;');
      totals.gt += count(raw, '&gt;');
      if (raw.includes('\t<restrictionTemplate>')) {
        totals.filesWithTemplates.push(entry.name);
      }

      const document = parseRightsXmlDocument(raw);
      if ('error' in document) {
        totals.parseErrors.push(`${entry.name}: ${document.error}`);
      } else if (document.render() === raw) {
        totals.renderIdentical += 1;
      }

      let inObject = false;
      let objectName = '';
      let rightName = '';
      for (let line of raw.split('\n')) {
        if (line.endsWith('\r')) {
          line = line.slice(0, -1);
        }
        if (line === '\t<object>') {
          inObject = true;
          totals.objects += 1;
        } else if (line === '\t</object>') {
          inObject = false;
        } else if (inObject && line.startsWith('\t\t<name>')) {
          objectName = line.slice('\t\t<name>'.length, -'</name>'.length).replace(/&amp;/g, '&');
          if (/^Configuration(?:\.|$)/.test(objectName)) {
            if (objectName === 'Configuration') {
              totals.configurationBare += 1;
            } else {
              totals.configurationNamed += 1;
              totals.configurationNames.add(objectName);
            }
          }
          if (!seenNames.has(objectName)) {
            seenNames.add(objectName);
            const resolved = resolveRoleObjectName(objectName, { configurationName }, 'strict');
            if ('error' in resolved || resolved.name !== objectName) {
              totals.nameViolations.push(`${objectName} -> ${'error' in resolved ? resolved.error : resolved.name}`);
            }
          }
        } else if (inObject && line.startsWith('\t\t\t<name>')) {
          rightName = line.slice('\t\t\t<name>'.length, -'</name>'.length);
        } else if (inObject && line.startsWith('\t\t\t<value>')) {
          const parts = objectName.split('.');
          if (parts.length >= 3) {
            const key = `${parts[parts.length - 2]}:${rightName}`;
            totals.nestedPairs.set(key, (totals.nestedPairs.get(key) ?? 0) + 1);
          }
          if (!isAllowedRight(objectName, rightName) && totals.rootViolations.size < 50) {
            totals.rootViolations.add(`${objectName} :: ${rightName}`);
          }
        }
      }
    }
  });

  test('826 файлов; все разобраны без ошибок, render() без правок равен файлу байт-в-байт', () => {
    assert.strictEqual(totals.files, EXPECTED.files);
    assert.deepStrictEqual(totals.parseErrors, []);
    assert.strictEqual(totals.renderIdentical, EXPECTED.files);
  });

  test('раскладка эталона: xsi:type 826/826, BOM 826/826, хвостового перевода строки 0, только CRLF', () => {
    assert.strictEqual(totals.xsiType, EXPECTED.files);
    assert.strictEqual(totals.bom, EXPECTED.files);
    assert.strictEqual(totals.trailingNewline, 0);
    assert.strictEqual(totals.crlfOnly, EXPECTED.files);
  });

  test('<field> — 15 мест в 2 файлах, <condition/> — 1', () => {
    assert.strictEqual(totals.fieldTags, EXPECTED.fieldTags);
    assert.deepStrictEqual([...totals.fieldFiles].sort(), [...EXPECTED.fieldFiles].sort());
    assert.strictEqual(totals.emptyConditions, EXPECTED.emptyConditions);
  });

  test('сущности: &amp; 139 499, &lt; 59 573, &gt; 36 397', () => {
    assert.strictEqual(totals.amp, EXPECTED.amp);
    assert.strictEqual(totals.lt, EXPECTED.lt);
    assert.strictEqual(totals.gt, EXPECTED.gt);
  });

  test('объекты: всего 1 101 388; Configuration.<Имя> 704, голого Configuration 0, имя совпадает с Configuration.xml', () => {
    assert.strictEqual(totals.objects, EXPECTED.objects);
    assert.strictEqual(totals.configurationNamed, EXPECTED.configurationNamed);
    assert.strictEqual(totals.configurationBare, EXPECTED.configurationBare);
    assert.deepStrictEqual([...totals.configurationNames], [`Configuration.${configurationName}`]);
  });

  test('вложенные пары «вид:право» — ровно набор и числа эталона (в т.ч. Operation:Use 816, Method:Use 119, IntegrationServiceChannel:Use 8)', () => {
    assert.deepStrictEqual(Object.fromEntries(totals.nestedPairs), EXPECTED.nestedPairs);
  });

  test('каждое право эталона проходит isAllowedRight (ни одного ложного отказа)', () => {
    assert.deepStrictEqual([...totals.rootViolations], []);
  });

  test('каждое имя объекта эталона проходит strict-перевод без изменений (подсистемы глубиной до 10 сегментов, контейнеры, Configuration)', () => {
    assert.deepStrictEqual(totals.nameViolations.slice(0, 20), []);
  });

  suite('точечная правка на реальных файлах (копия во временный каталог)', () => {
    const roots: string[] = [];
    teardown(() => {
      for (const root of roots.splice(0)) {
        removeTreeSync(root);
      }
    });

    const service = new RoleRightsEditService();
    const samples = (): readonly string[] => ['Логист', 'БазовыеПраваБП', 'МК_Контрагент', totals.smallest.name];

    function expectedWithNewObject(original: string, name: string): string {
      const block = `${objectLines(name, [['Read', 'true']]).join('\r\n')}\r\n`;
      const templateIndex = original.indexOf('\t<restrictionTemplate>');
      const index = templateIndex >= 0 ? templateIndex : original.lastIndexOf('</Rights>');
      return original.slice(0, index) + block + original.slice(index);
    }

    for (const sample of ['Логист', 'БазовыеПраваБП', 'МК_Контрагент', '<самый маленький>']) {
      test(`${sample}: новый объект вставляется в точку вставки; повтор — без записи; BOM/CRLF/отсутствие хвоста целы`, function () {
        const name = sample === '<самый маленький>' ? totals.smallest.name : sample;
        assert.ok(samples().includes(name));
        const source = path.join(ROLES_DIR, name, 'Ext', 'Rights.xml');
        const root = makeTempRoot('v8vscedit-rights-corpus-edit-');
        roots.push(root);
        const target = path.join(root, 'Roles', name, 'Ext', 'Rights.xml');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(source, target);
        const original = fs.readFileSync(target, 'utf-8');

        const first = service.edit({ rightsPath: target, operations: [{ op: 'grant', object: 'Справочники.ТестовыйСправочникЭталона', rights: ['Read'] }] });
        assert.strictEqual(first.success, true, first.errors.join('; '));
        assert.strictEqual(first.changed, true);
        const edited = fs.readFileSync(target, 'utf-8');
        assert.strictEqual(edited, expectedWithNewObject(original, 'Catalog.ТестовыйСправочникЭталона'));
        assert.strictEqual(edited.charCodeAt(0), 0xfeff);
        assert.ok(!edited.endsWith('\n'));

        const mtime = fs.statSync(target).mtimeMs;
        const second = service.edit({ rightsPath: target, operations: [{ op: 'grant', object: 'Catalog.ТестовыйСправочникЭталона', rights: ['Read'] }] });
        assert.strictEqual(second.changed, false);
        assert.strictEqual(second.applied, 0);
        assert.strictEqual(fs.statSync(target).mtimeMs, mtime, 'повтор не перезаписывает файл');
        assert.strictEqual(fs.readFileSync(target, 'utf-8'), edited);
      });
    }

    test('файл с restrictionTemplate: правка шаблона трогает только его блок', function () {
      const source = path.join(ROLES_DIR, 'БазовыеПраваБП', 'Ext', 'Rights.xml');
      const root = makeTempRoot('v8vscedit-rights-corpus-tpl-');
      roots.push(root);
      const target = path.join(root, 'Roles', 'БазовыеПраваБП', 'Ext', 'Rights.xml');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      const original = fs.readFileSync(target, 'utf-8');
      const result = service.edit({ rightsPath: target, operations: [{ op: 'removeTemplate', name: 'ПоЗначениям' }] });
      assert.strictEqual(result.changed, true, result.warnings.join('; '));
      const edited = fs.readFileSync(target, 'utf-8');
      assert.ok(edited.length < original.length);
      assert.ok(!edited.includes('<name>ПоЗначениям</name>'));
      const start = original.indexOf('\t<restrictionTemplate>\r\n\t\t<name>ПоЗначениям</name>');
      assert.ok(start > 0);
      const endMarker = '\t</restrictionTemplate>\r\n';
      const end = original.indexOf(endMarker, start) + endMarker.length;
      assert.strictEqual(edited, original.slice(0, start) + original.slice(end));
    });
  });
});
