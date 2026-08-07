import { WorkflowPolicyError } from "./admission.ts";

export const MAX_WORKFLOW_ARGS_BYTES = 1024 * 1024;
export const MAX_WORKFLOW_SCHEMA_BYTES = 256 * 1024;
export const MAX_WORKFLOW_SCHEMA_DEPTH = 64;
export const MAX_STRUCTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_JSON_VALUE_DEPTH = 128;
const MAX_JSON_VALUE_NODES = 65_536;
const MAX_WORKFLOW_SCHEMA_NODES = 4_096;

const SCHEMA_ANNOTATION_KEYS = ["title", "description", "default"] as const;
const OBJECT_SCHEMA_KEYS = ["properties", "required", "additionalProperties"] as const;
const ARRAY_SCHEMA_KEYS = ["items", "minItems", "maxItems", "uniqueItems"] as const;
const STRING_SCHEMA_KEYS = ["minLength", "maxLength"] as const;
const NUMBER_SCHEMA_KEYS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
] as const;
const JSON_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const REFERENCE_KEYWORDS = new Set(["$ref", "$recursiveRef", "$dynamicRef"]);

export function assertWorkflowArgsLimit(args: unknown): void {
  if (args === undefined) return;
  assertJsonByteLimit(args, "workflow args", MAX_WORKFLOW_ARGS_BYTES);
}

export function assertWorkflowSchemaLimit(schema: unknown): void {
  if (schema === undefined || schema === null) return;
  assertJsonByteLimit(schema, "workflow schema", MAX_WORKFLOW_SCHEMA_BYTES);
  assertSchemaTreeBounds(schema);
  if (!isRecord(schema)) {
    throw new WorkflowPolicyError("workflow schema must be a plain JSON object");
  }
  validateSchemaNode(schema);
}

export function assertStructuredOutputLimit(value: unknown): void {
  assertJsonByteLimit(value, "workflow structured output", MAX_STRUCTURED_OUTPUT_BYTES);
}

export function assertWorkflowOutputLimit(value: unknown, label = "workflow output"): void {
  assertJsonByteLimit(value, label, MAX_STRUCTURED_OUTPUT_BYTES);
}

export function assertJsonByteLimit(value: unknown, label: string, maxBytes: number): void {
  assertPlainJsonValue(value, label);
  const serialized = JSON.stringify(value);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > maxBytes) {
    throw new WorkflowPolicyError(`${label} exceeds ${maxBytes} bytes`);
  }
}

function assertSchemaTreeBounds(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes++;
    if (nodes > MAX_WORKFLOW_SCHEMA_NODES) {
      throw new WorkflowPolicyError(`workflow schema exceeds ${MAX_WORKFLOW_SCHEMA_NODES} JSON nodes`);
    }
    if (depth > MAX_WORKFLOW_SCHEMA_DEPTH) {
      throw new WorkflowPolicyError(
        `workflow schema exceeds the ${MAX_WORKFLOW_SCHEMA_DEPTH}-level nesting limit`,
      );
    }
    if (!value || typeof value !== "object") continue;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function validateSchemaNode(node: Record<string, unknown>): void {
  for (const key of Object.keys(node)) {
    if (REFERENCE_KEYWORDS.has(key)) {
      throw new WorkflowPolicyError(`workflow schema ${key} is not supported; inline the referenced schema`);
    }
    if (key === "pattern" || key === "patternProperties") {
      throw new WorkflowPolicyError(
        `workflow schema ${key} is not supported because JavaScript regex validation has no reliable execution bound`,
      );
    }
  }

  validateAnnotations(node);
  const declaredTypes = validateSchemaTypes(node.type);
  const composites = ["anyOf", "allOf"].filter((key) => Object.hasOwn(node, key));
  if (Object.hasOwn(node, "oneOf")) {
    throw new WorkflowPolicyError("workflow schema oneOf is not supported; use non-overlapping anyOf branches");
  }
  if (composites.length > 1) {
    throw new WorkflowPolicyError("workflow schema may use only one of anyOf or allOf at each node");
  }

  const hasEnum = Object.hasOwn(node, "enum");
  const hasConst = Object.hasOwn(node, "const");
  if (hasEnum && hasConst) {
    throw new WorkflowPolicyError("workflow schema cannot combine enum and const at one node");
  }
  if (composites.length > 0 && (hasEnum || hasConst || declaredTypes.length > 0)) {
    throw new WorkflowPolicyError(
      "workflow schema anyOf/allOf nodes cannot also declare type, enum, or const",
    );
  }

  if (composites.length > 0) {
    const key = composites[0];
    assertOnlySchemaKeys(node, [...SCHEMA_ANNOTATION_KEYS, key]);
    const branches = node[key];
    if (!Array.isArray(branches) || branches.length === 0) {
      throw new WorkflowPolicyError(`workflow schema ${key} must be a non-empty array of schemas`);
    }
    for (const branch of branches) validateSchemaChild(branch, key);
    return;
  }

  if (hasEnum || hasConst) {
    assertOnlySchemaKeys(node, [...SCHEMA_ANNOTATION_KEYS, "type", hasEnum ? "enum" : "const"]);
    const values = hasEnum ? node.enum : [node.const];
    if (!Array.isArray(values) || values.length === 0) {
      throw new WorkflowPolicyError("workflow schema enum must be a non-empty array");
    }
    if (declaredTypes.length > 0) {
      for (const value of values) {
        if (!declaredTypes.some((type) => matchesJsonType(value, type))) {
          throw new WorkflowPolicyError("workflow schema enum/const value does not match its declared type");
        }
      }
    }
    return;
  }

  const inferredTypes = declaredTypes.length > 0 ? declaredTypes : inferSchemaTypes(node);
  const allowed = new Set<string>([...SCHEMA_ANNOTATION_KEYS, "type"]);
  for (const type of inferredTypes) {
    if (type === "object") for (const key of OBJECT_SCHEMA_KEYS) allowed.add(key);
    if (type === "array") for (const key of ARRAY_SCHEMA_KEYS) allowed.add(key);
    if (type === "string") for (const key of STRING_SCHEMA_KEYS) allowed.add(key);
    if (type === "number" || type === "integer") for (const key of NUMBER_SCHEMA_KEYS) allowed.add(key);
  }
  assertOnlySchemaKeys(node, allowed);

  if (inferredTypes.includes("object")) validateObjectSchema(node);
  if (inferredTypes.includes("array")) validateArraySchema(node);
  if (inferredTypes.includes("string")) {
    validateNonNegativeInteger(node.minLength, "minLength");
    validateNonNegativeInteger(node.maxLength, "maxLength");
  }
  if (inferredTypes.includes("number") || inferredTypes.includes("integer")) {
    for (const key of NUMBER_SCHEMA_KEYS) validateFiniteNumber(node[key], key);
    if (node.multipleOf !== undefined && (node.multipleOf as number) <= 0) {
      throw new WorkflowPolicyError("workflow schema multipleOf must be greater than zero");
    }
  }
}

function validateObjectSchema(node: Record<string, unknown>): void {
  const properties = node.properties;
  if (properties !== undefined && !isRecord(properties)) {
    throw new WorkflowPolicyError("workflow schema properties must be an object of schemas");
  }
  if (properties) {
    for (const child of Object.values(properties)) validateSchemaChild(child, "properties");
  }

  const required = node.required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) {
      throw new WorkflowPolicyError("workflow schema required must be an array of property names");
    }
    if (new Set(required).size !== required.length) {
      throw new WorkflowPolicyError("workflow schema required must not contain duplicates");
    }
    for (const key of required) {
      if (!properties || !Object.hasOwn(properties, key)) {
        throw new WorkflowPolicyError(`workflow schema required property ${JSON.stringify(key)} is not defined`);
      }
    }
  }

  const additional = node.additionalProperties;
  if (additional !== undefined && typeof additional !== "boolean") {
    validateSchemaChild(additional, "additionalProperties");
  }
}

function validateArraySchema(node: Record<string, unknown>): void {
  const items = node.items;
  if (items !== undefined) {
    if (Array.isArray(items)) {
      for (const child of items) validateSchemaChild(child, "items");
    } else {
      validateSchemaChild(items, "items");
    }
  }
  validateNonNegativeInteger(node.minItems, "minItems");
  validateNonNegativeInteger(node.maxItems, "maxItems");
  if (node.uniqueItems !== undefined && typeof node.uniqueItems !== "boolean") {
    throw new WorkflowPolicyError("workflow schema uniqueItems must be a boolean");
  }
}

function validateSchemaChild(value: unknown, keyword: string): void {
  if (!isRecord(value)) {
    throw new WorkflowPolicyError(`workflow schema ${keyword} must contain schema objects`);
  }
  validateSchemaNode(value);
}

function validateSchemaTypes(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0 || values.some((type) => typeof type !== "string" || !JSON_SCHEMA_TYPES.has(type))) {
    throw new WorkflowPolicyError("workflow schema type must contain supported JSON type names");
  }
  if (new Set(values).size !== values.length) {
    throw new WorkflowPolicyError("workflow schema type must not contain duplicates");
  }
  return values as string[];
}

function inferSchemaTypes(node: Record<string, unknown>): string[] {
  const object = OBJECT_SCHEMA_KEYS.some((key) => Object.hasOwn(node, key));
  const array = ARRAY_SCHEMA_KEYS.some((key) => Object.hasOwn(node, key));
  const scalar = [...STRING_SCHEMA_KEYS, ...NUMBER_SCHEMA_KEYS].find((key) => Object.hasOwn(node, key));
  if (scalar) {
    throw new WorkflowPolicyError(`workflow schema ${scalar} requires an explicit type`);
  }
  if (object && array) {
    throw new WorkflowPolicyError("workflow schema keywords require one unambiguous declared type");
  }
  return object ? ["object"] : array ? ["array"] : [];
}

function validateAnnotations(node: Record<string, unknown>): void {
  if (node.title !== undefined && typeof node.title !== "string") {
    throw new WorkflowPolicyError("workflow schema title must be a string");
  }
  if (node.description !== undefined && typeof node.description !== "string") {
    throw new WorkflowPolicyError("workflow schema description must be a string");
  }
}

function validateNonNegativeInteger(value: unknown, keyword: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new WorkflowPolicyError(`workflow schema ${keyword} must be a non-negative integer`);
  }
}

function validateFiniteNumber(value: unknown, keyword: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WorkflowPolicyError(`workflow schema ${keyword} must be a finite number`);
  }
}

function assertOnlySchemaKeys(node: Record<string, unknown>, allowedKeys: Iterable<string>): void {
  const allowed = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys);
  for (const key of Object.keys(node)) {
    if (!allowed.has(key)) {
      throw new WorkflowPolicyError(`workflow schema contains unsupported keyword ${key}`);
    }
  }
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "array": return Array.isArray(value);
    case "object": return isRecord(value);
    default: return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertPlainJsonValue(root: unknown, label: string): void {
  type Visit = { value: unknown; depth: number };
  const seen = new WeakSet<object>();
  const stack: Visit[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const visit = stack.pop()!;
    const value = visit.value;
    nodes++;
    if (nodes > MAX_JSON_VALUE_NODES) {
      throw new WorkflowPolicyError(`${label} exceeds ${MAX_JSON_VALUE_NODES} JSON nodes`);
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (Number.isFinite(value) && !Object.is(value, -0)) continue;
      throw new WorkflowPolicyError(`${label} must contain only durable finite JSON numbers (negative zero is unsupported)`);
    }
    if (!value || typeof value !== "object") {
      throw new WorkflowPolicyError(`${label} must be a plain JSON value`);
    }
    if (visit.depth > MAX_JSON_VALUE_DEPTH) {
      throw new WorkflowPolicyError(`${label} exceeds the ${MAX_JSON_VALUE_DEPTH}-level JSON nesting limit`);
    }
    if (seen.has(value)) {
      throw new WorkflowPolicyError(`${label} must be a JSON tree without repeated object references`);
    }
    seen.add(value);

    let descriptors: Record<string, PropertyDescriptor>;
    let symbols: symbol[];
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
      symbols = Object.getOwnPropertySymbols(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new WorkflowPolicyError(`${label} must be a plain JSON value: ${detail}`);
    }
    if (symbols.length > 0) throw new WorkflowPolicyError(`${label} must not contain symbol properties`);

    if (Array.isArray(value)) {
      const entries = Object.entries(descriptors).filter(([key]) => key !== "length");
      if (entries.length !== value.length) {
        throw new WorkflowPolicyError(`${label} arrays must not be sparse or contain extra properties`);
      }
      for (const [key, descriptor] of entries) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length) {
          throw new WorkflowPolicyError(`${label} arrays must not contain extra properties`);
        }
        if (!("value" in descriptor) || !descriptor.enumerable) {
          throw new WorkflowPolicyError(`${label} must not contain accessors or hidden properties`);
        }
        stack.push({ value: descriptor.value, depth: visit.depth + 1 });
      }
      continue;
    }

    let prototype: object | null;
    try {
      prototype = Object.getPrototypeOf(value);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new WorkflowPolicyError(`${label} must be a plain JSON object: ${detail}`);
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowPolicyError(`${label} must contain only plain JSON objects and arrays`);
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new WorkflowPolicyError(`${label} must not contain accessors or hidden properties`);
      }
      stack.push({ value: descriptor.value, depth: visit.depth + 1 });
    }
  }
}
