/**
 * Сборка командной строки Windows по алгоритму libuv `quote_cmd_arg`.
 *
 * Это тот же алгоритм, которым Node `spawn` собирает командную строку из массива аргументов.
 * Удалённый исполнитель (PSSession) передаёт процессу уже готовую строку, поэтому, квотируя её здесь
 * тем же алгоритмом, мы гарантируем, что удалённый 1cv8 получит байт-в-байт ту же командную строку,
 * что и локальный, — вектор аргументов остаётся под одним регресс-тестом.
 */

const NEEDS_QUOTES = /[ \t"]/;

export function quoteWindowsCommandLineArg(arg: string): string {
  if (arg === '') {
    return '""';
  }
  if (!NEEDS_QUOTES.test(arg)) {
    return arg;
  }
  // Ряд обратных косых значим только перед кавычкой (своей или закрывающей): CRT схлопывает
  // 2n косых перед `"` в n, поэтому такой ряд удваивается, а одиночные косые внутри не трогаются.
  let result = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') {
      result += '\\'.repeat(backslashes * 2 + 1) + '"';
    } else {
      result += '\\'.repeat(backslashes) + ch;
    }
    backslashes = 0;
  }
  return `${result}${'\\'.repeat(backslashes * 2)}"`;
}

/** Аргументы через один пробел, каждый квотирован отдельно; исполняемого файла в строке нет. */
export function buildWindowsCommandLine(args: readonly string[]): string {
  return args.map(quoteWindowsCommandLineArg).join(' ');
}
