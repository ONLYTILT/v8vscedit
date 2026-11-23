import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from '../fs/AtomicFileWriter';
import { resolveTemplateBodyByDescriptor, resolveTemplateBodyPath } from '../fs/MetaPathResolver';
import type { TemplateType } from './MetadataXmlCreator';
import { rootLocalNamePattern, sliceToRootElement, writeTextFilePreservingBomAndEol } from './XmlUtils';

const META_DATA_OBJECT_ROOT = rootLocalNamePattern('MetaDataObject');

const TEMPLATE_TYPES: ReadonlySet<string> = new Set<TemplateType>([
  'SpreadsheetDocument',
  'TextDocument',
  'HTMLDocument',
  'BinaryData',
  'DataCompositionSchema',
  'DataCompositionAppearanceTemplate',
  'GraphicalSchema',
  'AddIn',
]);

/** Читает тип макета из XML-описания макета. */
export function readTemplateTypeFromXml(xmlPath: string): TemplateType | null {
  if (!fs.existsSync(xmlPath)) {
    return null;
  }

  const xml = fs.readFileSync(xmlPath, 'utf-8');
  const value = /<TemplateType>\s*([^<]+?)\s*<\/TemplateType>/.exec(xml)?.[1]?.trim();
  return value && TEMPLATE_TYPES.has(value) ? value as TemplateType : null;
}

/**
 * Дескриптор макета: есть ли он на диске и какой тип в нём записан. Различать «нет
 * файла» и «тип не распознан» важно: первое для записи — отказ (макет не описан
 * метаданными), второе — повод пропустить проверку типа, а не отказать.
 */
export function inspectTemplateDescriptor(descriptorPath: string): { readonly exists: boolean; readonly type: TemplateType | null } {
  if (!fs.existsSync(descriptorPath)) {
    return { exists: false, type: null };
  }
  return { exists: true, type: readTemplateTypeFromXml(descriptorPath) };
}

/** Находит реальный файл содержимого текстового макета без его создания. */
export function resolveTextTemplateContentPath(templateXmlPath: string, templateName?: string): string | null {
  return getTextTemplateContentCandidates(templateXmlPath, templateName)
    .find((candidate) => fs.existsSync(candidate)) ?? null;
}

/** Возвращает существующий `Template.txt` или создаёт его в штатном каталоге макета. */
export function ensureTextTemplateContentPath(templateXmlPath: string, templateName?: string): string {
  const existing = resolveTextTemplateContentPath(templateXmlPath, templateName);
  if (existing) {
    return existing;
  }

  const contentPath = getDefaultTextTemplateContentPath(templateXmlPath, templateName);
  fs.mkdirSync(path.dirname(contentPath), { recursive: true });
  fs.writeFileSync(contentPath, '', 'utf-8');
  return contentPath;
}

function getTextTemplateContentCandidates(templateXmlPath: string, templateName?: string): string[] {
  const templateDir = path.dirname(templateXmlPath);
  const baseName = path.basename(templateXmlPath, '.xml');
  const name = templateName && templateName.length > 0 ? templateName : baseName;
  return [
    path.join(templateDir, name, 'Ext', 'Template.txt'),
    path.join(templateDir, 'Ext', 'Template.txt'),
  ];
}

function getDefaultTextTemplateContentPath(templateXmlPath: string, templateName?: string): string {
  const candidates = getTextTemplateContentCandidates(templateXmlPath, templateName);
  const templateDir = path.dirname(templateXmlPath);
  const baseName = path.basename(templateXmlPath, '.xml');
  const name = templateName && templateName.length > 0 ? templateName : baseName;
  return path.basename(templateDir) === name && candidates[1] ? candidates[1] : candidates[0];
}

/**
 * Путь СУЩЕСТВУЮЩЕГО тела макета по любому входу (каталог, тело, дескриптор).
 * Отказ вместо «вернуть вход как есть»: прежде дескриптор отдавался как тело,
 * и сервисы MXL/СКД читали и писали метаданные макета вместо содержимого.
 */
export function resolveExistingTemplateBody(inputPath: string): string {
  const body = isMissingTemplateDir(inputPath)
    ? path.join(path.resolve(inputPath), 'Ext', 'Template.xml')
    : resolveTemplateBodyPath(inputPath);
  if (!fs.existsSync(body)) {
    throw new Error(
      `Тело макета (Ext/Template.xml) не найдено: ${body}. ` +
      'Макет без содержимого — создай его через v8vscedit_add_template.'
    );
  }
  return body;
}

/**
 * Отсутствующий путь без расширения — каталог макета, которого ещё нет (тело не
 * выгружено). Для чтения это «тела нет» с подсказкой, а не ошибка формы пути;
 * `resolveTemplateBodyPath` такой вход отбивает, т.к. не знает, каталог ли это.
 */
function isMissingTemplateDir(inputPath: string): boolean {
  return path.extname(inputPath) === '' && !fs.existsSync(inputPath);
}

/**
 * Бросает, если на месте тела лежит дескриптор макета (корень `MetaDataObject`).
 * Конкретный корень тела не требуется: у макетов разных типов он разный
 * (`document`, `DataCompositionSchema`, …), а нераспознанный документ проверят
 * уже сами сервисы.
 */
export function assertTemplateBodyRoot(xml: string, filePath: string): void {
  const error = templateBodyRootError(xml, filePath);
  if (error) {
    throw new Error(error);
  }
}

/**
 * Текст ошибки guard'а корня тела или `null`. Отдельно от {@link assertTemplateBodyRoot}
 * для `validate_*`: валидатор обязан вернуть ОТЧЁТ с ошибкой, а не исключение.
 */
export function templateBodyRootError(xml: string, filePath: string): string | null {
  const root = sliceToRootElement(xml);
  if (root === null || !META_DATA_OBJECT_ROOT.test(root)) {
    return null;
  }
  const isBodyPath = path.basename(filePath) === 'Template.xml' && path.basename(path.dirname(filePath)) === 'Ext';
  const body = isBodyPath ? filePath : resolveTemplateBodyByDescriptor(filePath);
  return `По пути ${filePath} лежит дескриптор макета (MetaDataObject), а не его содержимое. Тело макета — ${body}.`;
}

/** Единственная точка чтения тела макета: существование + guard корневого элемента. */
export function readTemplateBody(inputPath: string): { path: string; xml: string } {
  const bodyPath = resolveExistingTemplateBody(inputPath);
  const xml = fs.readFileSync(bodyPath, 'utf-8');
  assertTemplateBodyRoot(xml, bodyPath);
  return { path: bodyPath, xml };
}

/**
 * Единственная точка записи тела макета (`compile_*`): путь всегда приводится к
 * ТЕЛУ, дескриптор на месте тела — отказ до любой записи. Новое тело пишется
 * атомарно, существующее — с сохранением BOM и переводов строк.
 */
export function writeTemplateBody(outputPath: string, xml: string): string {
  const bodyPath = resolveTemplateBodyPath(outputPath);
  if (fs.existsSync(bodyPath)) {
    const previous = fs.readFileSync(bodyPath, 'utf-8');
    assertTemplateBodyRoot(previous, bodyPath);
    writeTextFilePreservingBomAndEol(bodyPath, previous, xml);
    return bodyPath;
  }
  fs.mkdirSync(path.dirname(bodyPath), { recursive: true });
  writeFileAtomic(bodyPath, xml);
  return bodyPath;
}
