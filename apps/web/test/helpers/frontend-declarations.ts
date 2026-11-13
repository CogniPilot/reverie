/** Read actual JavaScript declarations without depending on formatting or evaluating startup code. */
import ts from 'typescript';
import vm from 'node:vm';

function script(source: string): ts.SourceFile {
  const file = ts.createSourceFile('frontend.js', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  if (ts.isExternalModule(file)) {
    const parsed = ts.transpileModule(source, {fileName: 'frontend.js', reportDiagnostics: true,
      compilerOptions: {allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS}});
    if (parsed.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error))
      throw new Error('Invalid frontend JavaScript module');
    new vm.Script(parsed.outputText, {filename: 'frontend.js'});
  } else new vm.Script(source, {filename: 'frontend.js'});
  return file;
}

export function frontendDeclarations(source: string, names: readonly string[]): string {
  const file = script(source);
  return names.map(name => {
    const matches: string[] = [];
    for (const statement of file.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
          const flags = statement.declarationList.flags;
          const kind = flags & ts.NodeFlags.Const ? 'const' : flags & ts.NodeFlags.Let ? 'let' : 'var';
          matches.push(`${kind} ${declaration.getText(file)};`);
        }
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
        matches.push(statement.getText(file));
      }
    }
    if (matches.length !== 1) throw new Error(`Expected one top-level frontend declaration: ${name}; found ${matches.length}`);
    return matches[0];
  }).join('\n');
}

/** Complete methods from one actual top-level class, without running its constructor/startup. */
export function frontendClassMethods(source: string, owner: string, names: readonly string[]): string {
  const file = script(source);
  const classes = file.statements.filter((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === owner);
  if (classes.length !== 1 || new Set(names).size !== names.length)
    throw new Error(`Expected one frontend class and unique requested methods: ${owner}`);
  const selected = classes[0];
  return names.map(name => {
    const matches = selected.members.filter(member => ts.isMethodDeclaration(member)
      && !(ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) && property(member.name) === name);
    if (matches.length !== 1) throw new Error(`Expected one frontend instance method: ${owner}.${name}; found ${matches.length}`);
    return matches[0].getText(file);
  }).join(',\n');
}

/** Complete top-level call statements; comments, strings and nested callbacks cannot impersonate startup. */
export function frontendCallStatements(source: string, callee: string, firstArgument?: string): string[] {
  const file = script(source);
  return file.statements.flatMap(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)
    && statement.expression.expression.text === callee
    && (firstArgument === undefined || statement.expression.arguments[0]
      && ts.isStringLiteralLike(statement.expression.arguments[0])
      && statement.expression.arguments[0].text === firstArgument) ? [statement.getText(file)] : []);
}

function property(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** Only declarations installed on the requested prototype can shadow its dispatch handlers. */
export function frontendPrototypeMethods(source: string, owner: string): string[] {
  const file = script(source), names: string[] = [];
  const prototype = (node: ts.Node): boolean => ts.isPropertyAccessExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === owner && node.name.text === 'prototype';
  const callable = (node: ts.Node): boolean => ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  const captured = new Map<string, {method: string; at: number}>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isPropertyAccessExpression(declaration.initializer)
        && prototype(declaration.initializer.expression)) captured.set(declaration.name.text, {
          method: declaration.initializer.name.text, at: statement.end,
        });
    }
  }
  // Existing extensions can wrap a handler without shadowing it. Prove the
  // immutable original capture and unconditional tail delegation; a lookalike,
  // wrong receiver/arguments or early return remains a conflicting definition.
  const delegates = (node: ts.Expression, name: string, assignment: ts.BinaryExpression): boolean => {
    if (!ts.isExpressionStatement(assignment.parent) || assignment.parent.parent !== file) return false;
    if (!ts.isFunctionExpression(node) || !node.body.statements.length) return false;
    const statements = node.body.statements, tail = statements[statements.length - 1];
    if (!ts.isReturnStatement(tail) || !tail.expression || !ts.isCallExpression(tail.expression)) return false;
    const call = tail.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'call'
      || !ts.isIdentifier(call.expression.expression)
      || call.arguments.length !== node.parameters.length + 1 || call.arguments[0].kind !== ts.SyntaxKind.ThisKeyword) return false;
    const alias = call.expression.expression.text, capture = captured.get(alias);
    if (!capture || capture.method !== name || capture.at > assignment.getStart(file)) return false;
    if (node.parameters.some(parameter => parameter.dotDotDotToken || parameter.initializer)) return false;
    const binds = (binding: ts.BindingName): boolean => ts.isIdentifier(binding) ? binding.text === alias
      : binding.elements.some(element => !ts.isOmittedExpression(element) && binds(element.name));
    if (node.parameters.some(parameter => binds(parameter.name))) return false;
    if (node.parameters.some((parameter, index) => !ts.isIdentifier(parameter.name)
      || !ts.isIdentifier(call.arguments[index + 1]) || call.arguments[index + 1].getText(file) !== parameter.name.text)) return false;
    let early = false;
    const returns = (part: ts.Node): void => {
      if (ts.isFunctionLike(part) || ts.isClassLike(part)) {
        if ((ts.isFunctionDeclaration(part) || ts.isClassDeclaration(part)) && part.name?.text === alias) early = true;
        return;
      }
      if (ts.isVariableDeclaration(part) && binds(part.name)) early = true;
      if (ts.isReturnStatement(part) || ts.isThrowStatement(part) || ts.isForStatement(part)
        || ts.isForInStatement(part) || ts.isForOfStatement(part) || ts.isWhileStatement(part)
        || ts.isDoStatement(part) || ts.isSwitchStatement(part) || ts.isTryStatement(part)) early = true;
      ts.forEachChild(part, returns);
    };
    statements.slice(0, -1).forEach(returns);
    return !early;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      // Only immediately invoked function bodies run during script setup.
      // A named callback/declaration cannot establish that its installs happened.
      let expression: ts.Node = node;
      while (ts.isParenthesizedExpression(expression.parent)) expression = expression.parent;
      if (ts.isCallExpression(expression.parent) && expression.parent.expression === expression
        && (ts.isFunctionExpression(node) || ts.isArrowFunction(node))) visit(node.body);
      return;
    }
    if (ts.isClassDeclaration(node) && node.parent === file && node.name?.text === owner) {
      for (const member of node.members) {
        if (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) continue;
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) && member.initializer && callable(member.initializer)) && member.name) {
          const name = property(member.name);
          if (name) names.push(name);
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Object'
      && node.expression.name.text === 'assign' && node.arguments[0] && prototype(node.arguments[0])) {
      for (const argument of node.arguments.slice(1)) {
        if (!ts.isObjectLiteralExpression(argument)) throw new Error('Unresolved frontend prototype mixin');
        for (const member of argument.properties) {
          if (ts.isSpreadAssignment(member)) throw new Error('Unresolved frontend prototype spread');
          if (ts.isMethodDeclaration(member) || ts.isPropertyAssignment(member) && callable(member.initializer)) {
            const name = property(member.name);
            if (name) names.push(name);
          }
        }
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && prototype(node.left.expression) && callable(node.right))
      if (!delegates(node.right, node.left.name.text, node)) names.push(node.left.name.text);
    if (ts.isClassLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}
