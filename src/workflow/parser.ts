/**
 * AST-validated parser for ultracode workflow scripts.
 *
 * A workflow script is plain JavaScript whose first statement must be a literal
 * `export const meta = { name, description, ... }`. The rest of the script runs
 * inside a deterministic vm sandbox (see runtime.ts), so we statically reject the
 * non-deterministic primitives that would break reproducible / resumable runs.
 */

import { parse } from "acorn";
import type { Node } from "acorn";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
  [key: string]: unknown;
}

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  /** Script with the `export const meta` statement removed and checkpoint-instrumented. */
  body: string;
}

export const WORKFLOW_CHECKPOINT_IDENTIFIER = "__ultracodeCheckpoint";
const WORKFLOW_LOOP_IDENTIFIER = "__ultracodeLoop";
const WORKFLOW_INVOKE_IDENTIFIER = "__ultracodeInvoke";
const WORKFLOW_INTERNAL_CALLS = {
  agent: "__ultracodeAgent",
  parallel: "__ultracodeParallel",
  pipeline: "__ultracodePipeline",
  workflow: "__ultracodeWorkflow",
} as const;
const WORKFLOW_RESERVED_IDENTIFIERS = new Set([
  WORKFLOW_CHECKPOINT_IDENTIFIER,
  WORKFLOW_LOOP_IDENTIFIER,
  WORKFLOW_INVOKE_IDENTIFIER,
  ...Object.values(WORKFLOW_INTERNAL_CALLS),
]);
export const DEFAULT_WORKFLOW_CHECKPOINT_LIMIT = 1_000_000;
const MAX_WORKFLOW_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_WORKFLOW_AST_DEPTH = 128;
const MAX_WORKFLOW_FUNCTION_DEPTH = 64;
const MAX_WORKFLOW_LITERAL_ITEMS = 65_536;

type AnyNode = Node & { [key: string]: any; start: number; end: number };

const NONDETERMINISM_ERROR =
  "Workflow scripts must be deterministic: Date.now(), Math.random(), and new Date() are unavailable. Pass timestamps via args and vary randomness by agent index.";

/** Strip a single Markdown code fence if the model wrapped the script in one. */
export function normalizeScript(script: string): string {
  let text = script.trim();
  const fence = text.match(/^```(?:js|javascript|mjs)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) text = fence[1].trim();
  return text;
}

export function parseWorkflowScript(rawScript: string): ParsedWorkflow {
  const script = normalizeScript(rawScript);
  if (Buffer.byteLength(script, "utf8") > MAX_WORKFLOW_SOURCE_BYTES) {
    throw new Error(`workflow script exceeds the ${MAX_WORKFLOW_SOURCE_BYTES}-byte source limit`);
  }
  let ast: AnyNode;
  try {
    ast = parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as AnyNode;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`workflow script is not valid JavaScript: ${detail}`);
  }

  const orchestrationBindings = collectOrchestrationBindings(ast);
  assertDeterministicAst(ast, orchestrationBindings);
  assertNoReservedIdentifiers(ast);
  assertStructuralLimits(ast);

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new Error("`export const meta = { name, description }` must be the first statement in the script");
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new Error("meta export must be `export const meta = ...`");
  }
  if (declaration.declarations.length !== 1) {
    throw new Error("the meta export must declare only `meta`");
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new Error("the meta export must declare `meta`");
  }
  if (!declarator.init) throw new Error("meta must have a literal value");

  const meta = evaluateLiteral(declarator.init, "meta") as WorkflowMeta;
  validateMeta(meta);

  return {
    meta,
    body: instrumentWorkflowBody(script.slice(0, first.start) + script.slice(first.end)),
  };
}

export function instrumentWorkflowBody(body: string): string {
  let ast: AnyNode;
  try {
    ast = parse(body, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as AnyNode;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`workflow script body is not valid JavaScript: ${detail}`);
  }
  assertNoReservedIdentifiers(ast);
  const checkpointReplacements: Array<{ start: number; end: number; text: string }> = [];
  const checkpointInsertions: Array<{ pos: number; text: string }> = [];
  collectCheckpointEdits(ast, body, checkpointInsertions, checkpointReplacements, new Set());
  const checkpointed = applySourceEdits(body, checkpointInsertions, checkpointReplacements);

  const instrumentedAst = parse(checkpointed, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as AnyNode;
  const callReplacements: Array<{ start: number; end: number; text: string }> = [];
  const callInsertions: Array<{ pos: number; text: string }> = [];
  collectCallSiteEdits(instrumentedAst, checkpointed, callInsertions, callReplacements);
  const instrumented = applySourceEdits(checkpointed, callInsertions, callReplacements);
  try {
    parse(instrumented, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`workflow instrumentation produced invalid JavaScript: ${detail}`);
  }
  return instrumented;
}

function applySourceEdits(
  source: string,
  insertions: Array<{ pos: number; text: string }>,
  replacements: Array<{ start: number; end: number; text: string }>,
): string {
  const edits = [
    ...replacements,
    ...insertions.map((edit) => ({ start: edit.pos, end: edit.pos, text: edit.text })),
  ];
  let out = source;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  }
  return out;
}

/** Evaluate a strictly-literal AST node (no identifiers, calls, or interpolation). */
function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread is not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties are allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys are not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors are not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name is not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays are not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread is not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation is not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only the negative-number unary operator is allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number")) {
    return String(node.value);
  }
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function assertDeterministicAst(
  node: AnyNode,
  orchestrationBindings: ReadonlySet<string>,
  parent?: AnyNode,
  grandparent?: AnyNode,
): void {
  if (isDateNowCall(node) || isMathRandomCall(node) || isNewDateExpression(node)) {
    throw new Error(NONDETERMINISM_ERROR);
  }
  if (isDynamicFunctionConstructor(node)) {
    throw new Error("Workflow scripts must not construct functions dynamically; use ordinary functions so checkpoints can be injected.");
  }
  if (isPromiseChainMember(node) || isPromiseChainCall(node) || isForbiddenPromiseDestructure(node, parent)) {
    throw new Error(
      "Workflow scripts must not access .then, .catch, or .finally promise chains; await or return orchestration calls directly.",
    );
  }
  if (isUnsupportedHelperCall(node, orchestrationBindings)) {
    throw new Error(
      "Workflow orchestration helpers must use a declared identifier or a static member on a declared object; assign complex receivers first.",
    );
  }
  if (isUnsupportedLoopHeader(node, orchestrationBindings)) {
    throw new Error("Workflow orchestration calls must be inside a loop body, not its initializer, condition, or update.");
  }
  if (isUnsupportedClassEagerOrchestration(node, orchestrationBindings)) {
    throw new Error("Workflow classes may call orchestration only from ordinary methods, not constructors, fields, or static blocks.");
  }
  if (isUnsupportedFactoryProperty(node) || isUnsupportedAccessorForwarding(node, orchestrationBindings)) {
    throw new Error("Workflow orchestration helper properties must use static methods; accessor forwarding is unsupported.");
  }
  if (isUnsupportedCompositeFactory(node)) {
    throw new Error("Workflow orchestration helper factories must use a direct function, object, or class declaration.");
  }
  if (isUnsupportedHelperAssignment(node, orchestrationBindings)) {
    throw new Error("Workflow orchestration helper functions must be declared, not assigned through a member expression.");
  }
  if (isForbiddenPromiseMember(node, parent) || isForbiddenPromiseCall(node)) {
    throw new Error(
      "Workflow scripts must not access native Promise combinators; use parallel() or pipeline() for deterministic concurrency.",
    );
  }
  if (
    isDynamicMethodCall(node)
    || isDynamicOrchestrationMember(node, orchestrationBindings)
    || isOrchestrationDestructure(node, orchestrationBindings)
    || isOrchestrationArgumentEscape(node, orchestrationBindings)
    || isOrchestrationFunctionAlias(node, parent)
    || isOrchestrationMemberAlias(node, parent, orchestrationBindings)
    || isOrchestrationBindingEscape(node, parent, orchestrationBindings)
  ) {
    throw new Error(
      "Workflow scripts must use a static method name; dynamic method calls can bypass deterministic promise checks.",
    );
  }
  if (node.type === "Identifier" && node.name === "globalThis") {
    throw new Error("Workflow scripts must not access globalThis; use the declared workflow globals directly.");
  }
  if (
    node.type === "MemberExpression"
    && node.object?.type === "ThisExpression"
    && ORCHESTRATION_FUNCTIONS.has(propertyNameOf(node) ?? "")
  ) {
    throw new Error("Workflow orchestration globals must be called directly so call sites remain stable.");
  }
  if (node.type === "Identifier" && node.name === "Promise" && !isAllowedPromiseReference(node, parent, grandparent)) {
    throw new Error(
      "Workflow scripts only allow new Promise(...) and Promise.resolve(...); use parallel() or pipeline() instead of native Promise combinators.",
    );
  }
  for (const child of astChildren(node)) {
    assertDeterministicAst(child, orchestrationBindings, node, parent);
  }
}

function assertStructuralLimits(root: AnyNode): void {
  const visit = (node: AnyNode, depth: number, functionDepth: number): void => {
    if (depth > MAX_WORKFLOW_AST_DEPTH) {
      throw new Error(`workflow script exceeds the ${MAX_WORKFLOW_AST_DEPTH}-level AST nesting depth limit`);
    }
    const nextFunctionDepth = functionDepth + (isFunctionNode(node) ? 1 : 0);
    if (nextFunctionDepth > MAX_WORKFLOW_FUNCTION_DEPTH) {
      throw new Error(`workflow script exceeds the ${MAX_WORKFLOW_FUNCTION_DEPTH}-level function nesting limit`);
    }
    if (node.type === "ArrayExpression" && (node.elements?.length ?? 0) > MAX_WORKFLOW_LITERAL_ITEMS) {
      throw new Error(`workflow array literal exceeds ${MAX_WORKFLOW_LITERAL_ITEMS} items`);
    }
    if (node.type === "ObjectExpression" && (node.properties?.length ?? 0) > MAX_WORKFLOW_LITERAL_ITEMS) {
      throw new Error(`workflow object literal exceeds ${MAX_WORKFLOW_LITERAL_ITEMS} properties`);
    }
    if (node.type === "Literal" && typeof node.value === "string"
      && Buffer.byteLength(node.value, "utf8") > MAX_WORKFLOW_SOURCE_BYTES) {
      throw new Error(`workflow string literal exceeds ${MAX_WORKFLOW_SOURCE_BYTES} bytes`);
    }
    for (const child of astChildren(node)) visit(child, depth + 1, nextFunctionDepth);
  };
  visit(root, 0, 0);
}

function assertNoReservedIdentifiers(node: AnyNode): void {
  if (node.type === "Identifier" && WORKFLOW_RESERVED_IDENTIFIERS.has(node.name)) {
    throw new Error(`workflow scripts may not use the reserved identifier ${node.name}`);
  }
  for (const child of astChildren(node)) assertNoReservedIdentifiers(child);
}

function collectCallSiteEdits(
  root: AnyNode,
  source: string,
  insertions: Array<{ pos: number; text: string }>,
  replacements: Array<{ start: number; end: number; text: string }>,
): void {
  const orchestrationBindings = collectOrchestrationBindings(root);
  const localFunctions = collectLocalFunctionNames(root, orchestrationBindings);
  const stack: Array<{ node: AnyNode; loops: string[] }> = [{ node: root, loops: [] }];
  while (stack.length > 0) {
    const { node, loops } = stack.pop()!;
    if (
      node.type === "CallExpression"
      && node.callee?.type === "Identifier"
      && Object.hasOwn(WORKFLOW_INTERNAL_CALLS, node.callee.name)
    ) {
      const name = node.callee.name as keyof typeof WORKFLOW_INTERNAL_CALLS;
      const openOffset = source.slice(node.callee.end, node.end).indexOf("(");
      if (openOffset < 0) throw new Error(`unable to instrument workflow call site for ${name}`);
      const openParen = node.callee.end + openOffset;
      const loopSuffix = loops.length > 0 ? `@${loops.join(",")}` : "";
      const callSite = `${name}:${node.start.toString(36)}${loopSuffix}`;
      replacements.push({
        start: node.callee.start,
        end: node.callee.end,
        text: WORKFLOW_INTERNAL_CALLS[name],
      });
      insertions.push({
        pos: openParen + 1,
        text: `${JSON.stringify(callSite)}${node.arguments.length > 0 ? "," : ""}`,
      });
    } else if (node.type === "CallExpression" && (
      (node.callee?.type === "Identifier" && localFunctions.has(node.callee.name))
      || (node.callee?.type === "MemberExpression"
        && isTaintedStaticMember(node.callee, orchestrationBindings))
    )) {
      const openOffset = source.slice(node.callee.end, node.end).indexOf("(");
      if (openOffset < 0) throw new Error("unable to instrument workflow helper call site");
      const openParen = node.callee.end + openOffset;
      const loopSuffix = loops.length > 0 ? `@${loops.join(",")}` : "";
      const callSite = `invoke:${node.start.toString(36)}${loopSuffix}`;
      const callable = source.slice(node.callee.start, node.callee.end);
      const thisArg = node.callee.type === "MemberExpression"
        ? source.slice(node.callee.object.start, node.callee.object.end)
        : "undefined";
      replacements.push({
        start: node.callee.start,
        end: node.callee.end,
        text: WORKFLOW_INVOKE_IDENTIFIER,
      });
      insertions.push({
        pos: openParen + 1,
        text: `${JSON.stringify(callSite)},${callable},${thisArg}${node.arguments.length > 0 ? "," : ""}`,
      });
    }
    const body = isLoopStatement(node) ? node.body as AnyNode | undefined : undefined;
    const loopSite = body ? `loop:${node.start.toString(36)}` : undefined;
    if (body && loopSite) {
      if (body.type !== "BlockStatement") throw new Error("workflow loop instrumentation requires a block body");
      insertions.push({
        pos: body.start + 1,
        text: `\n${WORKFLOW_LOOP_IDENTIFIER}(${JSON.stringify(loopSite)});`,
      });
    }
    for (const child of astChildren(node)) {
      stack.push({
        node: child,
        loops: body && loopSite && child === body ? [...loops, loopSite] : loops,
      });
    }
  }
}

function collectLocalFunctionNames(root: AnyNode, bindings: ReadonlySet<string>): Set<string> {
  const names = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (
      node.type === "FunctionDeclaration"
      && node.id?.type === "Identifier"
      && bindings.has(node.id.name)
    ) names.add(node.id.name);
    if (
      node.type === "VariableDeclarator"
      && node.id?.type === "Identifier"
      && node.init
      && isFunctionNode(node.init)
      && bindings.has(node.id.name)
    ) names.add(node.id.name);
    stack.push(...astChildren(node));
  }
  return names;
}

function collectCheckpointEdits(
  node: AnyNode,
  source: string,
  insertions: Array<{ pos: number; text: string }>,
  replacements: Array<{ start: number; end: number; text: string }>,
  skipped: Set<AnyNode>,
): void {
  if (skipped.has(node)) return;
  if (isLoopStatement(node)) {
    const body = node.body as AnyNode | undefined;
    if (body?.type === "BlockStatement") {
      insertions.push({ pos: body.start + 1, text: `\n${WORKFLOW_CHECKPOINT_IDENTIFIER}();` });
    } else if (body) {
      replacements.push({
        start: body.start,
        end: body.end,
        text: `{\n${WORKFLOW_CHECKPOINT_IDENTIFIER}();\n${source.slice(body.start, body.end)}\n}`,
      });
      skipped.add(body);
    }
  }

  if (isFunctionNode(node)) {
    const body = node.body as AnyNode | undefined;
    if (body?.type === "BlockStatement") {
      insertions.push({ pos: body.start + 1, text: `\n${WORKFLOW_CHECKPOINT_IDENTIFIER}();` });
    } else if (body && node.type === "ArrowFunctionExpression") {
      replacements.push({
        start: body.start,
        end: body.end,
        text: `(${WORKFLOW_CHECKPOINT_IDENTIFIER}(), ${source.slice(body.start, body.end)})`,
      });
      skipped.add(body);
    }
  }

  for (const child of astChildren(node)) collectCheckpointEdits(child, source, insertions, replacements, skipped);
}

function isLoopStatement(node: AnyNode): boolean {
  return ["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"].includes(node.type);
}

function isFunctionNode(node: AnyNode): boolean {
  return ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type);
}

function astChildren(node: AnyNode): AnyNode[] {
  const children: AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) children.push(...value.filter(isAstNode));
    else if (isAstNode(value)) children.push(value);
  }
  return children;
}

function isAstNode(value: unknown): value is AnyNode {
  return !!value && typeof value === "object" && typeof (value as AnyNode).type === "string";
}

function isDateNowCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Date", "now");
}

function isMathRandomCall(node: AnyNode): boolean {
  return node.type === "CallExpression" && isMemberExpression(node.callee, "Math", "random");
}

function isNewDateExpression(node: AnyNode): boolean {
  return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Date";
}

function isDynamicFunctionConstructor(node: AnyNode): boolean {
  if ((node.type !== "CallExpression" && node.type !== "NewExpression") || node.callee?.type !== "Identifier") {
    return false;
  }
  return ["Function", "AsyncFunction", "GeneratorFunction", "AsyncGeneratorFunction"].includes(node.callee.name);
}

const ORCHESTRATION_FUNCTIONS = new Set(["agent", "parallel", "pipeline", "workflow"]);

function collectOrchestrationBindings(root: AnyNode): Set<string> {
  const dependencies = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  const seeds = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const definition = bindingDefinition(node);
    if (definition) {
      const deps = collectReferencedIdentifiers(definition.value);
      const existing = dependencies.get(definition.name) ?? new Set<string>();
      for (const dependency of deps) existing.add(dependency);
      dependencies.set(definition.name, existing);
      const tainted = isFactoryDefinition(definition.value)
        ? containsDirectOrchestration(definition.value)
        : containsUnconsumedOrchestration(definition.value);
      if (tainted) seeds.add(definition.name);
      if (definition.value.type === "ObjectExpression") {
        for (const member of objectFactoryMembers(definition.name, definition.value)) addMemberSeed(seeds, member);
      }
      for (const alias of collectStaticAliases(definition.name, definition.value)) {
        const targets = aliases.get(alias.source) ?? new Set<string>();
        targets.add(alias.target);
        aliases.set(alias.source, targets);
      }
    }
    stack.push(...astChildren(node));
  }
  for (const [name, deps] of dependencies) {
    for (const dependency of deps) {
      const dependents = reverse.get(dependency) ?? new Set<string>();
      dependents.add(name);
      reverse.set(dependency, dependents);
    }
  }
  const bindings = new Set(seeds);
  const queue = [...seeds];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const dependency = queue[queueIndex];
    for (const dependent of reverse.get(dependency) ?? []) {
      if (bindings.has(dependent)) continue;
      bindings.add(dependent);
      queue.push(dependent);
    }
    const parts = dependency.split(".");
    for (let prefixLength = parts.length; prefixLength >= 1; prefixLength--) {
      const source = parts.slice(0, prefixLength).join(".");
      const suffix = parts.slice(prefixLength).join(".");
      for (const target of aliases.get(source) ?? []) {
        const propagated = suffix ? `${target}.${suffix}` : target;
        if (bindings.has(propagated)) continue;
        bindings.add(propagated);
        queue.push(propagated);
      }
    }
  }
  return bindings;
}

function addMemberSeed(seeds: Set<string>, member: string): void {
  seeds.add(member);
  const parts = member.split(".");
  for (let length = 1; length < parts.length; length++) {
    seeds.add(`${parts.slice(0, length).join(".")}.*`);
  }
}

function collectStaticAliases(target: string, value: AnyNode): Array<{ source: string; target: string }> {
  if (value.type === "Identifier") return [{ source: value.name, target }];
  const member = staticMemberReference(value);
  if (member) return [{ source: member, target }];
  if (value.type !== "ObjectExpression") return [];
  const aliases: Array<{ source: string; target: string }> = [];
  for (const property of value.properties ?? []) {
    if (property.type !== "Property") continue;
    const key = property.computed
      ? staticStringOf(property.key)
      : property.key?.name ?? (typeof property.key?.value === "string" ? property.key.value : undefined);
    if (!key) continue;
    aliases.push(...collectStaticAliases(`${target}.${key}`, property.value));
  }
  return aliases;
}

function bindingDefinition(node: AnyNode): { name: string; value: AnyNode } | undefined {
  if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init) {
    return { name: node.id.name, value: node.init };
  }
  if (
    (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration")
    && node.id?.type === "Identifier"
  ) {
    return { name: node.id.name, value: node };
  }
  if (node.type === "AssignmentExpression") {
    if (node.left?.type === "Identifier") return { name: node.left.name, value: node.right };
    if (node.left?.type === "MemberExpression" && node.left.object?.type === "Identifier") {
      return { name: node.left.object.name, value: node.right };
    }
  }
  return undefined;
}

function collectReferencedIdentifiers(root: AnyNode): Set<string> {
  const references = new Set<string>();
  const stack: Array<{ node: AnyNode; parent?: AnyNode }> = [{ node: root }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    if (node.type === "Identifier" && isIdentifierReference(node, parent)) references.add(node.name);
    const member = staticMemberReference(node);
    if (member) references.add(member);
    for (const child of astChildren(node)) stack.push({ node: child, parent: node });
  }
  return references;
}

function objectFactoryMembers(name: string, node: AnyNode): string[] {
  const members: string[] = [];
  for (const property of node.properties ?? []) {
    if (property.type !== "Property") continue;
    const key = property.computed
      ? staticStringOf(property.key)
      : property.key?.name ?? (typeof property.key?.value === "string" ? property.key.value : undefined);
    if (!key) continue;
    const member = `${name}.${key}`;
    if (isFunctionNode(property.value) && containsDirectOrchestration(property.value)) members.push(member);
    if (property.value?.type === "ObjectExpression") {
      members.push(...objectFactoryMembers(member, property.value));
    }
  }
  return members;
}

function staticMemberReference(node: AnyNode): string | undefined {
  if (node.type !== "MemberExpression") return undefined;
  const property = propertyNameOf(node);
  if (!property) return undefined;
  if (node.object?.type === "Identifier") return `${node.object.name}.${property}`;
  const parent = staticMemberReference(node.object);
  return parent ? `${parent}.${property}` : undefined;
}

function isFactoryDefinition(node: AnyNode): boolean {
  return isFunctionNode(node) || node.type === "ClassExpression" || node.type === "ClassDeclaration";
}

function containsUnconsumedOrchestration(root: AnyNode): boolean {
  const stack: Array<{ node: AnyNode; parent?: AnyNode }> = [{ node: root }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    if (node.type === "AwaitExpression") continue;
    if (node !== root && isFunctionNode(node)) continue;
    if (
      node.type === "CallExpression"
      && node.callee?.type === "Identifier"
      && ORCHESTRATION_FUNCTIONS.has(node.callee.name)
    ) return true;
    if (isOrchestrationFunctionAlias(node, parent)) return true;
    for (const child of astChildren(node)) stack.push({ node: child, parent: node });
  }
  return false;
}

function containsDirectOrchestration(root: AnyNode): boolean {
  const stack: Array<{ node: AnyNode; parent?: AnyNode }> = [{ node: root }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    if (
      node.type === "CallExpression"
      && node.callee?.type === "Identifier"
      && ORCHESTRATION_FUNCTIONS.has(node.callee.name)
    ) return true;
    if (isOrchestrationFunctionAlias(node, parent)) return true;
    for (const child of astChildren(node)) stack.push({ node: child, parent: node });
  }
  return false;
}

function isIdentifierReference(node: AnyNode, parent?: AnyNode): boolean {
  if (!parent) return true;
  if (parent.type === "Property" && parent.key === node && !parent.computed) return false;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (parent.type === "VariableDeclarator" && parent.id === node) return false;
  if ((parent.type === "FunctionDeclaration" || parent.type === "ClassDeclaration") && parent.id === node) return false;
  return true;
}

function isOrchestrationExpression(
  node: AnyNode | undefined,
  bindings: ReadonlySet<string>,
): boolean {
  if (!node) return false;
  if (node.type === "Identifier") return bindings.has(node.name) || hasTaintedMember(bindings, node.name);
  if (node.type === "CallExpression") {
    if (
      node.callee?.type === "Identifier"
      && (ORCHESTRATION_FUNCTIONS.has(node.callee.name) || bindings.has(node.callee.name))
    ) return true;
    if (node.callee?.type === "MemberExpression") {
      return isTaintedStaticMember(node.callee, bindings);
    }
    if (isFunctionNode(node.callee)) return containsDirectOrchestration(node.callee);
  }
  if (node.type === "MemberExpression") {
    return isTaintedStaticMember(node, bindings);
  }
  if (node.type === "ChainExpression") return isOrchestrationExpression(node.expression, bindings);
  if (node.type === "NewExpression") {
    return (node.callee?.type === "Identifier" && bindings.has(node.callee.name))
      || node.arguments.some((argument: AnyNode) =>
        argument.type === "SpreadElement"
          ? isOrchestrationExpression(argument.argument, bindings)
          : isOrchestrationExpression(argument, bindings)
      );
  }
  if (node.type === "ArrayExpression") {
    return node.elements.some((element: AnyNode | null) =>
      !!element && (element.type === "SpreadElement"
        ? isOrchestrationExpression(element.argument, bindings)
        : isOrchestrationExpression(element, bindings))
    );
  }
  if (node.type === "ObjectExpression") {
    return node.properties.some((property: AnyNode) =>
      property.type === "SpreadElement"
        ? isOrchestrationExpression(property.argument, bindings)
        : property.type === "Property"
          && !isFunctionNode(property.value)
          && isOrchestrationExpression(property.value, bindings)
    );
  }
  if (node.type === "ClassExpression" || node.type === "ClassDeclaration" || isFunctionNode(node)) {
    return false;
  }
  if (node.type === "ConditionalExpression") {
    return isOrchestrationExpression(node.consequent, bindings)
      || isOrchestrationExpression(node.alternate, bindings);
  }
  if (node.type === "LogicalExpression" || node.type === "AssignmentExpression") {
    return isOrchestrationExpression(node.left, bindings)
      || isOrchestrationExpression(node.right, bindings);
  }
  if (node.type === "SequenceExpression") {
    return node.expressions.some((expression: AnyNode) => isOrchestrationExpression(expression, bindings));
  }
  return false;
}

function isDynamicOrchestrationMember(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  return node.type === "MemberExpression"
    && node.computed
    && propertyNameOf(node) === undefined
    && isOrchestrationExpression(node.object, bindings);
}

function isOrchestrationArgumentEscape(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  if (node.type === "TaggedTemplateExpression") {
    return (node.quasi?.expressions ?? []).some((expression: AnyNode) =>
      isOrchestrationExpression(expression, bindings)
    );
  }
  if (
    node.type === "CallExpression"
    && node.callee?.type === "Identifier"
    && ORCHESTRATION_FUNCTIONS.has(node.callee.name)
  ) return false;
  return (node.type === "CallExpression" || node.type === "NewExpression")
    && node.arguments.some((argument: AnyNode) =>
      argument.type === "SpreadElement"
        ? isOrchestrationExpression(argument.argument, bindings)
        : isOrchestrationExpression(argument, bindings)
    );
}

function isUnsupportedHelperCall(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  if (node.type !== "CallExpression") return false;
  if (node.callee?.type === "MemberExpression") {
    if (node.callee.object?.type === "ThisExpression" || node.callee.object?.type === "AwaitExpression") return true;
    return (node.callee.object?.type === "CallExpression" || node.callee.object?.type === "NewExpression")
      && isOrchestrationExpression(node.callee.object, bindings);
  }
  return node.callee?.type === "CallExpression" && isOrchestrationExpression(node.callee, bindings);
}

function isUnsupportedLoopHeader(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  let expressions: Array<AnyNode | undefined> = [];
  if (node.type === "ForStatement") expressions = [node.init, node.test, node.update];
  else if (node.type === "ForInStatement" || node.type === "ForOfStatement") expressions = [node.right];
  else if (node.type === "WhileStatement" || node.type === "DoWhileStatement") expressions = [node.test];
  else return false;
  return expressions.some((expression) => !!expression
    && (containsDirectOrchestration(expression) || isOrchestrationExpression(expression, bindings)));
}

function isUnsupportedClassEagerOrchestration(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  if (node.type === "StaticBlock") return containsOrchestrationCall(node, bindings);
  if (node.type === "MethodDefinition" && node.kind === "constructor") {
    return containsOrchestrationCall(node.value, bindings);
  }
  if (node.type === "PropertyDefinition" && node.value) {
    return containsOrchestrationCall(node.value, bindings) || isOrchestrationExpression(node.value, bindings);
  }
  return false;
}

function containsOrchestrationCall(root: AnyNode, bindings: ReadonlySet<string>): boolean {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "CallExpression" && isOrchestrationExpression(node, bindings)) return true;
    stack.push(...astChildren(node));
  }
  return false;
}

function isUnsupportedFactoryProperty(node: AnyNode): boolean {
  if (node.type !== "Property" && node.type !== "MethodDefinition") return false;
  const value = node.value as AnyNode | undefined;
  return !!value
    && isFunctionNode(value)
    && containsDirectOrchestration(value)
    && node.computed
    && staticStringOf(node.key) === undefined;
}

function isUnsupportedAccessorForwarding(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  if ((node.type !== "Property" && node.type !== "MethodDefinition") || node.kind !== "get") return false;
  const value = node.value as AnyNode | undefined;
  if (!value) return false;
  const stack = [value];
  while (stack.length > 0) {
    const child = stack.pop()!;
    if (child.type === "ThisExpression") return true;
    if (child.type === "Identifier"
      && (bindings.has(child.name) || hasTaintedMember(bindings, child.name))) return true;
    stack.push(...astChildren(child));
  }
  return containsDirectOrchestration(value);
}

function isUnsupportedCompositeFactory(node: AnyNode): boolean {
  if (node.type !== "VariableDeclarator" || !node.init) return false;
  return ["ConditionalExpression", "LogicalExpression", "SequenceExpression"].includes(node.init.type)
    && containsDirectOrchestration(node.init);
}

function isUnsupportedHelperAssignment(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  if (node.type !== "AssignmentExpression") return false;
  const orchestrationValue = isFunctionNode(node.right)
    ? containsDirectOrchestration(node.right)
    : isOrchestrationExpression(node.right, bindings);
  return orchestrationValue
    && (node.left?.type === "Identifier" || node.left?.type === "MemberExpression");
}

function hasTaintedMember(bindings: ReadonlySet<string>, name: string): boolean {
  return bindings.has(`${name}.*`);
}

function isOrchestrationBindingEscape(
  node: AnyNode,
  parent: AnyNode | undefined,
  bindings: ReadonlySet<string>,
): boolean {
  if (node.type !== "Identifier" || !parent) return false;
  const memberContainer = hasTaintedMember(bindings, node.name);
  if (!bindings.has(node.name) && !memberContainer) return false;
  if (memberContainer) {
    if (parent.type === "MemberExpression" && parent.object === node) return false;
    if (parent.type === "VariableDeclarator" && parent.id === node) return false;
    if ((parent.type === "FunctionDeclaration" || parent.type === "ClassDeclaration") && parent.id === node) return false;
    if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return false;
    return true;
  }
  if (parent.type === "VariableDeclarator") return parent.init === node;
  if (parent.type === "AssignmentExpression") return parent.right === node;
  if (parent.type === "Property") return parent.value === node && (parent.shorthand || parent.key !== node);
  if (parent.type === "ReturnStatement") return parent.argument === node;
  return false;
}

function isTaintedStaticMember(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  const member = staticMemberReference(node);
  if (!member) return isOrchestrationExpression(node.object, bindings);
  if (bindings.has(member) || hasTaintedMember(bindings, member)) return true;
  return node.object?.type === "Identifier" && bindings.has(node.object.name);
}

function isOrchestrationMemberAlias(
  node: AnyNode,
  parent: AnyNode | undefined,
  bindings: ReadonlySet<string>,
): boolean {
  if (node.type !== "MemberExpression") return false;
  if (!isTaintedStaticMember(node, bindings)) return false;
  return !(parent?.type === "CallExpression" && parent.callee === node);
}

function isOrchestrationFunctionAlias(node: AnyNode, parent?: AnyNode): boolean {
  if (node.type !== "Identifier" || !ORCHESTRATION_FUNCTIONS.has(node.name)) return false;
  if (parent?.type === "CallExpression" && parent.callee === node) return false;
  if (parent?.type === "Property" && parent.key === node && !parent.computed) return false;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  return true;
}

function isOrchestrationDestructure(node: AnyNode, bindings: ReadonlySet<string>): boolean {
  return node.type === "VariableDeclarator"
    && (node.id?.type === "ObjectPattern" || node.id?.type === "ArrayPattern")
    && isOrchestrationExpression(node.init, bindings);
}

function isPromiseChainCall(node: AnyNode): boolean {
  return node.type === "CallExpression"
    && node.callee?.type === "MemberExpression"
    && ["then", "catch", "finally"].includes(propertyNameOf(node.callee) ?? "");
}

function isPromiseChainMember(node: AnyNode): boolean {
  return node.type === "MemberExpression"
    && ["then", "catch", "finally"].includes(propertyNameOf(node) ?? "");
}

function isForbiddenPromiseDestructure(node: AnyNode, parent?: AnyNode): boolean {
  return node.type === "Property"
    && parent?.type === "ObjectPattern"
    && ["then", "catch", "finally"].includes(propertyNameOf(node) ?? propertyKeyName(node.key) ?? "");
}

function isDynamicMethodCall(node: AnyNode): boolean {
  return node.type === "CallExpression"
    && node.callee?.type === "MemberExpression"
    && node.callee.computed
    && propertyNameOf(node.callee) === undefined;
}

function propertyKeyName(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Identifier") return node.name;
  return staticStringOf(node);
}

function isForbiddenPromiseCall(node: AnyNode): boolean {
  return node.type === "CallExpression"
    && node.callee?.type === "MemberExpression"
    && node.callee.object?.type === "Identifier"
    && node.callee.object.name === "Promise"
    && ["all", "allSettled", "race", "any"].includes(propertyNameOf(node.callee) ?? "");
}

function isForbiddenPromiseMember(node: AnyNode, parent?: AnyNode): boolean {
  if (node.type !== "MemberExpression") return false;
  const property = propertyNameOf(node);
  if (property === "Promise") return true;
  return ["all", "allSettled", "race", "any"].includes(property ?? "")
    && parent?.type === "CallExpression"
    && parent.callee === node;
}

function isAllowedPromiseReference(node: AnyNode, parent?: AnyNode, grandparent?: AnyNode): boolean {
  if (parent?.type === "NewExpression" && parent.callee === node) return true;
  return parent?.type === "MemberExpression"
    && parent.object === node
    && propertyNameOf(parent) === "resolve"
    && grandparent?.type === "CallExpression"
    && grandparent.callee === parent;
}

function isMemberExpression(node: AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "MemberExpression" || node.object?.type !== "Identifier" || node.object.name !== objectName) {
    return false;
  }
  return propertyNameOf(node) === propertyName;
}

function propertyNameOf(node: AnyNode): string | undefined {
  if (!node.computed && node.property?.type === "Identifier") return node.property.name;
  return staticStringOf(node.property);
}

function staticStringOf(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticStringOf(node.left);
    const right = staticStringOf(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("meta.description must be a non-empty string");
  }
  if (value.whenToUse !== undefined && typeof value.whenToUse !== "string") {
    throw new Error("meta.whenToUse must be a string");
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}
