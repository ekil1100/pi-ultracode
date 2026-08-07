/**
 * Convert a plain JSON Schema (as written inside a workflow script's
 * `agent(prompt, { schema })`) into a TypeBox `TSchema` so Pi can both validate
 * the subagent's structured output and serialize a faithful tool schema to the model.
 *
 * Covers the explicitly validated workflow JSON Schema subset. Unsupported
 * keywords are rejected before conversion rather than silently weakened.
 */

import { Type, type TSchema } from "typebox";
import { assertWorkflowSchemaLimit } from "./value-limits.ts";

type Json = Record<string, any>;

export function jsonSchemaToTypeBox(schema: unknown): TSchema {
  assertWorkflowSchemaLimit(schema);
  return convertJsonSchema(schema);
}

function convertJsonSchema(schema: unknown): TSchema {
  if (!schema || typeof schema !== "object") {
    // No constraints -> accept anything.
    return Type.Unsafe<unknown>({});
  }
  const node = schema as Json;
  const annotations = pickAnnotations(node);

  // Composite keywords first.
  if (Array.isArray(node.enum)) {
    return withAnnotations(Type.Unsafe<unknown>({
      ...(node.type !== undefined ? { type: node.type } : {}),
      enum: node.enum,
    }), annotations);
  }
  if ("const" in node) {
    return withAnnotations(Type.Unsafe<unknown>({
      ...(node.type !== undefined ? { type: node.type } : {}),
      const: node.const,
    }), annotations);
  }
  if (Array.isArray(node.anyOf)) {
    return withAnnotations(Type.Union(node.anyOf.map(convertJsonSchema)), annotations);
  }
  if (Array.isArray(node.allOf)) {
    return withAnnotations(Type.Intersect(node.allOf.map(convertJsonSchema)), annotations);
  }

  const type = node.type;
  if (Array.isArray(type)) {
    // e.g. ["string", "null"]
    return withAnnotations(
      Type.Union(type.map((t: string) => convertJsonSchema({ ...node, type: t, enum: undefined }))),
      annotations,
    );
  }

  switch (type) {
    case "object":
      return withAnnotations(objectSchema(node), annotations);
    case "array":
      return withAnnotations(arraySchema(node), annotations);
    case "string":
      return withAnnotations(Type.String(numericAndStringConstraints(node)), annotations);
    case "number":
      return withAnnotations(Type.Number(numericAndStringConstraints(node)), annotations);
    case "integer":
      return withAnnotations(Type.Integer(numericAndStringConstraints(node)), annotations);
    case "boolean":
      return withAnnotations(Type.Boolean(), annotations);
    case "null":
      return withAnnotations(Type.Null(), annotations);
    default:
      // Untyped object with properties is still an object.
      if (node.properties) return withAnnotations(objectSchema(node), annotations);
      if (node.items) return withAnnotations(arraySchema(node), annotations);
      return Type.Unsafe<unknown>({ ...node });
  }
}

function objectSchema(node: Json): TSchema {
  const properties: Record<string, TSchema> = Object.create(null);
  const required: string[] = Array.isArray(node.required) ? node.required : [];
  const props = (node.properties ?? {}) as Json;
  for (const [key, value] of Object.entries(props)) {
    const child = convertJsonSchema(value);
    properties[key] = required.includes(key) ? child : Type.Optional(child);
  }
  const options: Json = {};
  if (node.additionalProperties === false) options.additionalProperties = false;
  else if (node.additionalProperties && typeof node.additionalProperties === "object") {
    options.additionalProperties = convertJsonSchema(node.additionalProperties);
  }
  return Type.Object(properties, options);
}

function arraySchema(node: Json): TSchema {
  const options: Json = {};
  if (typeof node.minItems === "number") options.minItems = node.minItems;
  if (typeof node.maxItems === "number") options.maxItems = node.maxItems;
  if (node.uniqueItems === true) options.uniqueItems = true;
  if (Array.isArray(node.items)) {
    return Type.Tuple(node.items.map(convertJsonSchema), {
      ...options,
      additionalItems: true,
      minItems: options.minItems ?? 0,
    });
  }
  return Type.Array(node.items ? convertJsonSchema(node.items) : Type.Unknown(), options);
}

function numericAndStringConstraints(node: Json): Json {
  const out: Json = {};
  for (const key of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
  ]) {
    if (node[key] !== undefined) out[key] = node[key];
  }
  return out;
}

function pickAnnotations(node: Json): Json {
  const out: Json = {};
  if (typeof node.description === "string") out.description = node.description;
  if (typeof node.title === "string") out.title = node.title;
  if (node.default !== undefined) out.default = node.default;
  return out;
}

function withAnnotations(schema: TSchema, annotations: Json): TSchema {
  if (Object.keys(annotations).length === 0) return schema;
  return { ...schema, ...annotations } as TSchema;
}
