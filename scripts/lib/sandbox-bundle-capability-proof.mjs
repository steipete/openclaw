import path from "node:path";

const TELEGRAM_ARCHIVE_ENTRY = "/extensions/telegram/index.js";
const MAX_PACKAGED_MODULE_BYTES = 16 * 1024 * 1024;
const MAX_PACKAGED_MODULE_COUNT = 10_000;
const MAX_PACKAGED_MODULE_TOTAL_BYTES = 128 * 1024 * 1024;
const REGEX_PREFIX_KEYWORDS = new Set([
  "await",
  "break",
  "case",
  "continue",
  "debugger",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);
const CONTROL_PAREN_KEYWORDS = new Set(["catch", "for", "if", "switch", "while", "with"]);

export function sandboxArchiveModulePath(fileName, entryName) {
  const normalized = entryName.replace(/^\.\/+/, "");
  return fileName === "channels.tar.gz" ? `/extensions/${normalized}` : `/${normalized}`;
}

export async function readSandboxArchiveJavaScriptModules({ archives }) {
  const { list } = await import("tar");
  const modules = [];
  const reads = [];
  let readError;
  let scheduledBytes = 0;
  let scheduledModules = 0;
  for (const { archivePath, fileName } of archives) {
    await list({
      file: archivePath,
      noResume: true,
      strict: true,
      onReadEntry: (entry) => {
        const entryName = entry.path.replace(/^\.\/+/, "");
        const isRegularFile = ["File", "OldFile", "ContiguousFile"].includes(entry.type);
        const isJavaScript = entryName.endsWith(".js") && !entryName.includes("/node_modules/");
        const isRelevant =
          isRegularFile &&
          isJavaScript &&
          (fileName !== "channels.tar.gz" || entryName.startsWith("telegram/"));
        if (!isRelevant || readError) {
          entry.resume();
          return;
        }
        if (entry.size > MAX_PACKAGED_MODULE_BYTES) {
          readError = new Error(
            `packaged module exceeds proof read limit: ${fileName}:${entryName}`,
          );
          entry.resume();
          return;
        }
        scheduledBytes += entry.size;
        scheduledModules += 1;
        if (
          scheduledBytes > MAX_PACKAGED_MODULE_TOTAL_BYTES ||
          scheduledModules > MAX_PACKAGED_MODULE_COUNT
        ) {
          readError = new Error(`packaged module proof input exceeds aggregate limit: ${fileName}`);
          entry.resume();
          return;
        }
        reads.push(
          entry.concat().then(
            (content) => {
              modules.push({
                fileName,
                entryName,
                label: `${fileName}:${entryName}`,
                virtualPath: sandboxArchiveModulePath(fileName, entryName),
                content,
              });
            },
            (error) => {
              readError ??= error;
            },
          ),
        );
      },
    });
  }
  await Promise.all(reads);
  if (readError) {
    throw readError;
  }
  return modules;
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/u.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/u.test(char);
}

function canEndExpression(token) {
  if (!token) {
    return false;
  }
  if (token.type === "identifier") {
    return !REGEX_PREFIX_KEYWORDS.has(token.value);
  }
  if (["number", "string", "regex", "template"].includes(token.type)) {
    return true;
  }
  if (token.value === ")") {
    return !token.closesControl;
  }
  return token.value === "]";
}

function skipQuotedLiteral(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
    } else if (source[index] === quote) {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return source.length;
}

function skipRegexLiteral(source, start) {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
    } else if (char === "]") {
      inCharacterClass = false;
    } else if (char === "/" && !inCharacterClass) {
      index += 1;
      while (/[A-Za-z]/u.test(source[index] ?? "")) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return source.length;
}

function skipTemplateInterpolation(source, start) {
  let index = start;
  let depth = 1;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '"' || char === "'") {
      index = skipQuotedLiteral(source, index, char);
    } else if (char === "`") {
      index = skipTemplateLiteral(source, index);
    } else if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === "/") {
      // Treat ambiguous division as regex while skipping template data. The
      // conservative result can only reject proof; it cannot expose string data as code.
      index = skipRegexLiteral(source, index);
    } else if (char === "{") {
      depth += 1;
      index += 1;
    } else if (char === "}") {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return index;
      }
    } else {
      index += 1;
    }
  }
  return source.length;
}

function skipTemplateLiteral(source, start) {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
    } else if (source[index] === "`") {
      return index + 1;
    } else if (source[index] === "$" && source[index + 1] === "{") {
      index = skipTemplateInterpolation(source, index + 2);
    } else {
      index += 1;
    }
  }
  return source.length;
}

function tokenizeJavaScript(source) {
  const tokens = [];
  const controlParentheses = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      let escaped = false;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === "\\") {
          escaped = true;
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ type: "string", value: escaped ? null : value });
      continue;
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index);
      tokens.push({ type: "template", value: null });
      continue;
    }
    if (char === "/" && !canEndExpression(tokens.at(-1))) {
      index = skipRegexLiteral(source, index);
      tokens.push({ type: "regex", value: null });
      continue;
    }
    if (isIdentifierStart(char)) {
      const start = index;
      index += 1;
      while (isIdentifierPart(source[index] ?? "")) {
        index += 1;
      }
      tokens.push({ type: "identifier", value: source.slice(start, index) });
      continue;
    }
    if (/[0-9]/u.test(char)) {
      const start = index;
      index += 1;
      while (/[0-9]/u.test(source[index] ?? "")) {
        index += 1;
      }
      tokens.push({ type: "number", value: source.slice(start, index) });
      continue;
    }
    const token = { type: "punctuation", value: char };
    if (char === "(") {
      const previous = tokens.at(-1);
      const beforePrevious = tokens.at(-2);
      const followsForAwait =
        previous?.type === "identifier" &&
        previous.value === "await" &&
        beforePrevious?.type === "identifier" &&
        beforePrevious.value === "for";
      controlParentheses.push(
        followsForAwait ||
          (previous?.type === "identifier" && CONTROL_PAREN_KEYWORDS.has(previous.value)),
      );
    } else if (char === ")") {
      token.closesControl = controlParentheses.pop() ?? false;
    }
    tokens.push(token);
    index += 1;
  }
  return tokens;
}

function tokensMatch(tokens, start, expected) {
  return expected.every(
    ([type, value], offset) =>
      tokens[start + offset]?.type === type && tokens[start + offset]?.value === value,
  );
}

function hasDeclaration(tokens, name, value) {
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (
      tokensMatch(tokens, index, [
        ["identifier", "const"],
        ["identifier", name],
        ["punctuation", "="],
        ["string", value],
      ])
    ) {
      return true;
    }
  }
  return false;
}

function findMatchingParenthesis(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index].value === "(") {
      depth += 1;
    } else if (tokens[index].value === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function hasTelegramDurableAckProducer(tokens) {
  if (
    !hasDeclaration(tokens, "TELEGRAM_WEBHOOK_ACCEPTED_HEADER", "x-openclaw-delivery-accepted") ||
    !hasDeclaration(tokens, "TELEGRAM_WEBHOOK_ACCEPTED_VALUE", "durable")
  ) {
    return false;
  }
  const acknowledgement = [
    ["punctuation", ";"],
    ["identifier", "res"],
    ["punctuation", "."],
    ["identifier", "setHeader"],
    ["punctuation", "("],
    ["identifier", "TELEGRAM_WEBHOOK_ACCEPTED_HEADER"],
    ["punctuation", ","],
    ["identifier", "TELEGRAM_WEBHOOK_ACCEPTED_VALUE"],
    ["punctuation", ")"],
    ["punctuation", ";"],
    ["identifier", "respondText"],
    ["punctuation", "("],
    ["number", "200"],
    ["punctuation", ")"],
    ["punctuation", ";"],
  ];
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (
      !tokensMatch(tokens, index, [
        ["identifier", "await"],
        ["identifier", "writeTelegramSpooledUpdate"],
        ["punctuation", "("],
        ["punctuation", "{"],
      ])
    ) {
      continue;
    }
    const closeIndex = findMatchingParenthesis(tokens, index + 2);
    if (closeIndex !== -1 && tokensMatch(tokens, closeIndex + 1, acknowledgement)) {
      return true;
    }
  }
  return false;
}

function referencedModules(tokens) {
  const references = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let reference;
    if (token.type === "identifier" && token.value === "from") {
      reference = tokens[index + 1]?.type === "string" ? tokens[index + 1].value : null;
    } else if (token.type === "identifier" && token.value === "import") {
      reference =
        tokens[index + 1]?.type === "string"
          ? tokens[index + 1].value
          : tokens[index + 1]?.value === "(" && tokens[index + 2]?.type === "string"
            ? tokens[index + 2].value
            : null;
    } else if (token.type === "identifier" && token.value === "specifier") {
      reference =
        tokens[index + 1]?.value === ":" && tokens[index + 2]?.type === "string"
          ? tokens[index + 2].value
          : null;
    }
    if (/^\.{1,2}\/.+\.js$/u.test(reference ?? "")) {
      references.push(reference);
    }
  }
  return references;
}

export function findTelegramDurableAckProducer(sources) {
  for (const source of sources) {
    if (hasTelegramDurableAckProducer(tokenizeJavaScript(source.text))) {
      return source.label;
    }
  }
  return null;
}

export async function findReachableTelegramDurableAckProducer({ modules, readText }) {
  const modulesByPath = new Map();
  for (const module of modules) {
    if (modulesByPath.has(module.virtualPath)) {
      throw new Error(`duplicate packaged module path: ${module.virtualPath}`);
    }
    modulesByPath.set(module.virtualPath, module);
  }

  const pending = [TELEGRAM_ARCHIVE_ENTRY];
  const visited = new Set();
  while (pending.length > 0) {
    const virtualPath = pending.pop();
    if (visited.has(virtualPath)) {
      continue;
    }
    visited.add(virtualPath);
    const module = modulesByPath.get(virtualPath);
    if (!module) {
      continue;
    }
    const text = await readText(module);
    const tokens = tokenizeJavaScript(text);
    if (hasTelegramDurableAckProducer(tokens)) {
      return module.label;
    }
    for (const reference of referencedModules(tokens)) {
      pending.push(path.posix.resolve(path.posix.dirname(virtualPath), reference));
    }
  }
  return null;
}
