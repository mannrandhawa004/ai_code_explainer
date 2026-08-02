import path from "node:path";

import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

import {
  LineBasedChunker,
  detectRepositorySourceLanguage,
  type ChunkedRepositorySymbol,
  type CodeChunk,
  type LineBasedChunkerOptions,
  type LineChunkSourceMetadata,
  type SourceFileChunkingResult,
} from "./line-based-chunker.js";

export const defaultMaximumTreeSitterNodes = 250_000;

export type TreeSitterChunkerOptions = {
  maxAstNodes?: number;
};

type SupportedTreeSitterLanguage =
  | "javascript"
  | "jsx"
  | "typescript"
  | "tsx";

type ParsedSymbol = ChunkedRepositorySymbol & {
  exported: boolean;
  node: Parser.SyntaxNode;
};

const expressRouteMethods = new Set([
  "all",
  "connect",
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
  "use",
]);

const supportedLanguages = new Set<SupportedTreeSitterLanguage>([
  "javascript",
  "jsx",
  "typescript",
  "tsx",
]);

function isSupportedLanguage(
  language: string,
): language is SupportedTreeSitterLanguage {
  return supportedLanguages.has(language as SupportedTreeSitterLanguage);
}

function grammarFor(language: SupportedTreeSitterLanguage): unknown {
  switch (language) {
    case "javascript":
    case "jsx":
      return JavaScript;
    case "typescript":
      return TypeScript.typescript;
    case "tsx":
      return TypeScript.tsx;
  }
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith("`") && trimmed.endsWith("`")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function safeSymbolName(value: string): string | undefined {
  const normalized = unquote(value).trim();
  return normalized && !normalized.includes("\0") ? normalized : undefined;
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function visitNamedNodes(
  root: Parser.SyntaxNode,
  maxNodes: number,
  visitor: (node: Parser.SyntaxNode) => void,
): boolean {
  const stack = [root];
  let visited = 0;

  while (stack.length > 0) {
    const node = stack.pop()!;
    visited += 1;
    if (visited > maxNodes) {
      return false;
    }
    visitor(node);
    for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
      stack.push(node.namedChildren[index]!);
    }
  }

  return true;
}

function containsNodeType(
  root: Parser.SyntaxNode,
  nodeTypes: ReadonlySet<string>,
): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (nodeTypes.has(node.type)) {
      return true;
    }
    for (let index = node.namedChildren.length - 1; index >= 0; index -= 1) {
      stack.push(node.namedChildren[index]!);
    }
  }
  return false;
}

function nodeLineRange(node: Parser.SyntaxNode): {
  startLine: number;
  endLine: number;
} {
  return {
    startLine: node.startPosition.row + 1,
    endLine: Math.max(node.startPosition.row + 1, node.endPosition.row + 1),
  };
}

function declarationRangeNode(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let rangeNode = node;
  if (
    node.type === "variable_declarator" ||
    node.type === "public_field_definition" ||
    node.type === "field_definition"
  ) {
    const declaration = node.parent;
    if (
      declaration?.type === "lexical_declaration" ||
      declaration?.type === "variable_declaration"
    ) {
      rangeNode = declaration;
    }
  }
  if (rangeNode.parent?.type === "export_statement") {
    rangeNode = rangeNode.parent;
  }
  return rangeNode;
}

function isExported(node: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null = node;
  while (current && current.type !== "program") {
    if (current.type === "export_statement") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function declarationNames(node: Parser.SyntaxNode): string[] {
  if (
    node.type === "lexical_declaration" ||
    node.type === "variable_declaration"
  ) {
    return node.namedChildren
      .filter((child) => child.type === "variable_declarator")
      .flatMap((child) => {
        const name = child.childForFieldName("name");
        const safeName = name === null ? undefined : safeSymbolName(name.text);
        return safeName === undefined ? [] : [safeName];
      });
  }

  const name = node.childForFieldName("name");
  const safeName = name === null ? undefined : safeSymbolName(name.text);
  return safeName === undefined ? [] : [safeName];
}

function collectImports(root: Parser.SyntaxNode): string[] {
  const imports: string[] = [];

  visitNamedNodes(root, Number.MAX_SAFE_INTEGER, (node) => {
    if (node.type === "import_statement") {
      const source = node.childForFieldName("source");
      if (source !== null) {
        const moduleName = safeSymbolName(source.text);
        if (moduleName !== undefined) {
          imports.push(moduleName);
        }
      }
      visitNamedNodes(node, Number.MAX_SAFE_INTEGER, (child) => {
        if (child.type === "identifier") {
          const importedName = safeSymbolName(child.text);
          if (importedName !== undefined) {
            imports.push(importedName);
          }
        }
      });
      return;
    }

    if (node.type !== "call_expression") {
      return;
    }
    const callable = node.childForFieldName("function");
    if (callable?.text !== "require") {
      return;
    }
    const argumentsNode = node.childForFieldName("arguments");
    const source = argumentsNode?.namedChildren[0];
    if (source !== undefined) {
      const moduleName = safeSymbolName(source.text);
      if (moduleName !== undefined) {
        imports.push(moduleName);
      }
    }
    const importedBinding = node.parent?.childForFieldName("name");
    if (importedBinding !== null && importedBinding !== undefined) {
      const bindingName = safeSymbolName(importedBinding.text);
      if (bindingName !== undefined) {
        imports.push(bindingName);
      }
    }
  });

  return uniqueInOrder(imports);
}

function collectExports(root: Parser.SyntaxNode): string[] {
  const exports: string[] = [];

  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") {
      continue;
    }
    const declaration = node.childForFieldName("declaration");
    if (declaration !== null) {
      exports.push(...declarationNames(declaration));
    }
    for (const specifier of node.namedChildren.filter(
      (child) => child.type === "export_clause",
    ).flatMap((clause) => clause.namedChildren)) {
      if (specifier.type !== "export_specifier") {
        continue;
      }
      const exportedName =
        specifier.childForFieldName("alias") ??
        specifier.childForFieldName("name") ??
        specifier.lastNamedChild;
      if (exportedName !== null) {
        const safeName = safeSymbolName(exportedName.text);
        if (safeName !== undefined) {
          exports.push(safeName);
        }
      }
    }
    if (
      declaration === null &&
      node.text.includes("export default") &&
      !exports.includes("default")
    ) {
      exports.push("default");
    }
  }

  return uniqueInOrder(exports);
}

function fileRole(filePath: string): "controller" | "service" | "model" | undefined {
  const normalized = filePath.toLowerCase();
  const basename = path.posix.basename(normalized);
  if (/(?:^|\/)controllers?(?:\/|$)|(?:^|[.-])controller(?:[.-]|$)/u.test(normalized)) {
    return "controller";
  }
  if (/(?:^|\/)services?(?:\/|$)|(?:^|[.-])service(?:[.-]|$)/u.test(normalized)) {
    return "service";
  }
  if (
    /(?:^|\/)models?(?:\/|$)|(?:^|[.-])(?:model|schema)(?:[.-]|$)/u.test(
      normalized,
    ) ||
    basename.endsWith("schema.ts") ||
    basename.endsWith("schema.js")
  ) {
    return "model";
  }
  return undefined;
}

function looksLikeReactComponent(name: string, node: Parser.SyntaxNode): boolean {
  return (
    /^[A-Z][A-Za-z0-9_$]*$/u.test(name) &&
    containsNodeType(
      node,
      new Set(["jsx_element", "jsx_self_closing_element", "jsx_fragment"]),
    )
  );
}

function classifyNamedSymbol(
  name: string,
  node: Parser.SyntaxNode,
  filePath: string,
  fallbackType: string,
): string {
  if (looksLikeReactComponent(name, node)) {
    return "react_component";
  }
  const role = fileRole(filePath);
  if (role !== undefined) {
    return role;
  }
  if (/Controller$/u.test(name)) {
    return "controller";
  }
  if (/Service$/u.test(name)) {
    return "service";
  }
  if (/(?:Model|Schema)$/u.test(name)) {
    return "model";
  }
  return fallbackType;
}

function collectReferences(node: Parser.SyntaxNode, symbolName: string): string[] {
  const references: string[] = [];
  visitNamedNodes(node, Number.MAX_SAFE_INTEGER, (child) => {
    if (
      child.type !== "identifier" &&
      child.type !== "type_identifier" &&
      child.type !== "shorthand_property_identifier_pattern"
    ) {
      return;
    }
    const name = safeSymbolName(child.text);
    if (name !== undefined && name !== symbolName) {
      references.push(name);
    }
  });
  return uniqueInOrder(references).slice(0, 500);
}

function isTopLevelVariable(node: Parser.SyntaxNode): boolean {
  const declaration = node.parent;
  if (
    declaration?.type !== "lexical_declaration" &&
    declaration?.type !== "variable_declaration"
  ) {
    return false;
  }
  return (
    declaration.parent?.type === "program" ||
    (declaration.parent?.type === "export_statement" &&
      declaration.parent.parent?.type === "program")
  );
}

function variableSymbolType(
  name: string,
  value: Parser.SyntaxNode,
  filePath: string,
): string | undefined {
  const callable =
    value.type === "arrow_function" || value.type === "function_expression";
  if (callable || looksLikeReactComponent(name, value)) {
    return classifyNamedSymbol(name, value, filePath, "arrow_function");
  }
  if (
    /(?:^|\.)(?:Schema|model)\s*\(/u.test(value.text) ||
    /(?:Model|Schema)$/u.test(name)
  ) {
    return "model";
  }
  return undefined;
}

function expressRouteSymbol(node: Parser.SyntaxNode): {
  name: string;
  rangeNode: Parser.SyntaxNode;
} | undefined {
  if (node.type !== "call_expression") {
    return undefined;
  }
  const callable = node.childForFieldName("function");
  if (callable?.type !== "member_expression") {
    return undefined;
  }
  const receiver = callable.childForFieldName("object");
  const property = callable.childForFieldName("property");
  const method = property?.text.toLowerCase();
  if (
    receiver === null ||
    receiver === undefined ||
    method === undefined ||
    !expressRouteMethods.has(method) ||
    !/(?:^|\b)(?:app|api|router|server)(?:\b|$)/iu.test(receiver.text)
  ) {
    return undefined;
  }
  const argumentsNode = node.childForFieldName("arguments");
  const firstArgument = argumentsNode?.namedChildren[0];
  const routePath =
    firstArgument === undefined ? undefined : safeSymbolName(firstArgument.text);
  const rangeNode =
    node.parent?.type === "expression_statement" ? node.parent : node;
  return {
    name: `${method.toUpperCase()} ${routePath ?? receiver.text}`,
    rangeNode,
  };
}

function collectSymbols(
  root: Parser.SyntaxNode,
  filePath: string,
  imports: readonly string[],
  maxNodes: number,
): ParsedSymbol[] | undefined {
  const symbols: ParsedSymbol[] = [];
  const seen = new Set<string>();

  const addSymbol = (
    nameValue: string,
    type: string,
    sourceNode: Parser.SyntaxNode,
    exported = isExported(sourceNode),
  ): void => {
    const name = safeSymbolName(nameValue);
    if (name === undefined) {
      return;
    }
    const node = declarationRangeNode(sourceNode);
    const { startLine, endLine } = nodeLineRange(node);
    const key = `${startLine}\0${endLine}\0${type}\0${name}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    symbols.push({
      name,
      type,
      startLine,
      endLine,
      imports: [...imports],
      references: collectReferences(node, name),
      exported,
      node,
    });
  };

  const completed = visitNamedNodes(root, maxNodes, (node) => {
    const route = expressRouteSymbol(node);
    if (route !== undefined) {
      addSymbol(route.name, "express_route", route.rangeNode, false);
    }

    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) {
          addSymbol(
            name.text,
            classifyNamedSymbol(name.text, node, filePath, "function"),
            node,
          );
        }
        break;
      }
      case "class_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) {
          addSymbol(
            name.text,
            classifyNamedSymbol(name.text, node, filePath, "class"),
            node,
          );
        }
        break;
      }
      case "method_definition": {
        const name = node.childForFieldName("name");
        if (name !== null) {
          addSymbol(name.text, "method", node, false);
        }
        break;
      }
      case "interface_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) {
          addSymbol(name.text, "interface", node);
        }
        break;
      }
      case "type_alias_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) {
          addSymbol(name.text, "type_alias", node);
        }
        break;
      }
      case "enum_declaration": {
        const name = node.childForFieldName("name");
        if (name !== null) {
          addSymbol(name.text, "enum", node);
        }
        break;
      }
      case "variable_declarator": {
        const nameNode = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (nameNode === null || value === null) {
          break;
        }
        const name = safeSymbolName(nameNode.text);
        if (name === undefined) {
          break;
        }
        const symbolType = variableSymbolType(name, value, filePath);
        if (symbolType !== undefined) {
          addSymbol(name, symbolType, node);
        } else if (isTopLevelVariable(node)) {
          addSymbol(name, "variable", node);
        }
        break;
      }
      case "public_field_definition":
      case "field_definition": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (
          name !== null &&
          value !== null &&
          (value.type === "arrow_function" || value.type === "function_expression")
        ) {
          addSymbol(name.text, "method", node, false);
        }
        break;
      }
    }
  });

  if (!completed) {
    return undefined;
  }

  return symbols.sort(
    (left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      left.type.localeCompare(right.type) ||
      left.name.localeCompare(right.name),
  );
}

function sliceLines(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  return lines.slice(startLine - 1, endLine).join("\n");
}

export class TreeSitterCodeChunker {
  private readonly maxAstNodes: number;

  constructor(
    private readonly lineChunker: LineBasedChunker = new LineBasedChunker(),
    options: TreeSitterChunkerOptions = {},
  ) {
    this.maxAstNodes = options.maxAstNodes ?? defaultMaximumTreeSitterNodes;
    assertPositiveInteger(this.maxAstNodes, "maxAstNodes");
  }

  chunk(
    content: string,
    metadata: LineChunkSourceMetadata,
    lineOptions: LineBasedChunkerOptions = {},
  ): SourceFileChunkingResult {
    const language =
      metadata.language ?? detectRepositorySourceLanguage(metadata.filePath);
    if (!isSupportedLanguage(language)) {
      return this.lineFallback(content, metadata, lineOptions, "line");
    }

    try {
      const parser = new Parser();
      parser.setLanguage(grammarFor(language));
      const tree = parser.parse(content);
      if (tree.rootNode.hasError) {
        return this.lineFallback(
          content,
          metadata,
          lineOptions,
          "line_fallback",
        );
      }

      const imports = collectImports(tree.rootNode);
      const exports = collectExports(tree.rootNode);
      const symbols = collectSymbols(
        tree.rootNode,
        metadata.filePath,
        imports,
        this.maxAstNodes,
      );
      if (symbols === undefined) {
        return this.lineFallback(
          content,
          metadata,
          lineOptions,
          "line_fallback",
        );
      }

      if (symbols.length === 0) {
        return {
          chunks: this.lineChunker.chunk(
            content,
            { ...metadata, imports, exports },
            lineOptions,
          ),
          chunkingStrategy: "tree_sitter",
          imports,
          exports,
          symbols: [],
        };
      }

      const lines = content.split(/\r\n|\n|\r/u);
      const chunks: CodeChunk[] = [];
      for (const symbol of symbols) {
        const symbolExports = symbol.exported
          ? exports.filter(
              (exportedName) =>
                exportedName === symbol.name || exportedName === "default",
            )
          : [];
        chunks.push(
          ...this.lineChunker.chunk(
            sliceLines(lines, symbol.startLine, symbol.endLine),
            {
              ...metadata,
              sourceStartLine: symbol.startLine,
              symbolType: symbol.type,
              symbolName: symbol.name,
              imports,
              exports: symbolExports,
              references: symbol.references,
            },
            lineOptions,
          ),
        );
      }

      return {
        chunks: chunks.map((chunk, chunkIndex) => ({ ...chunk, chunkIndex })),
        chunkingStrategy: "tree_sitter",
        imports,
        exports,
        symbols: symbols.map(({ exported: _exported, node: _node, ...symbol }) =>
          symbol,
        ),
      };
    } catch {
      return this.lineFallback(
        content,
        metadata,
        lineOptions,
        "line_fallback",
      );
    }
  }

  private lineFallback(
    content: string,
    metadata: LineChunkSourceMetadata,
    lineOptions: LineBasedChunkerOptions,
    chunkingStrategy: SourceFileChunkingResult["chunkingStrategy"],
  ): SourceFileChunkingResult {
    return {
      chunks: this.lineChunker.chunk(content, metadata, lineOptions),
      chunkingStrategy,
      imports: [],
      exports: [],
      symbols: [],
    };
  }
}
