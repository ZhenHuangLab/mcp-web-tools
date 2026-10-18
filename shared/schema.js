// Validates tool arguments against the JSON Schema that the tool advertises, and fills in the
// declared defaults. MCP calls and the REST API both go through this check, so the limits a
// model reads in tools/list are exactly the limits the server enforces.
//
// Only the keywords the tool schemas use are supported: type, enum, properties, required,
// additionalProperties, items, minItems, maxItems, minimum, maximum, and default.

/** An error whose message is safe and useful to show to the caller. */
export class ToolError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "ToolError";
    this.status = status;
  }
}

export function validateArguments(schema, value) {
  return check(schema, value, "");
}

/**
 * Turns URL query parameters into tool arguments, converting values of integer and boolean
 * properties from their text form. Validation is left to validateArguments.
 */
export function argumentsFromQuery(schema, searchParams) {
  const args = {};
  for (const [key, value] of searchParams) {
    const type = schema.properties?.[key]?.type;
    if (type === "integer" && /^-?\d+$/.test(value)) args[key] = Number(value);
    else if (type === "boolean" && (value === "true" || value === "false")) args[key] = value === "true";
    else args[key] = value;
  }
  return args;
}

function check(schema, value, path) {
  if (value === undefined) return schema.default;
  const label = path || "arguments";

  if (schema.enum && !schema.enum.includes(value)) {
    throw new ToolError(`${label} must be one of: ${schema.enum.join(", ")}.`);
  }

  switch (schema.type) {
    case "object":
      return checkObject(schema, value, path, label);
    case "array":
      return checkArray(schema, value, path, label);
    case "string":
      if (typeof value !== "string") throw new ToolError(`${label} must be a string.`);
      return value;
    case "integer":
      if (!Number.isInteger(value)) throw new ToolError(`${label} must be an integer.`);
      checkRange(schema, value, label);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new ToolError(`${label} must be true or false.`);
      return value;
    default:
      return value;
  }
}

function checkObject(schema, value, path, label) {
  if (!isPlainObject(value)) throw new ToolError(`${label} must be an object.`);
  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    if (value[key] === undefined) throw new ToolError(`${childPath(path, key)} is required.`);
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (Object.hasOwn(properties, key)) continue;
    if (schema.additionalProperties === false) {
      const supported = Object.keys(properties).join(", ");
      throw new ToolError(`${childPath(path, key)} is not a supported argument. Supported arguments: ${supported}.`);
    }
    result[key] = isPlainObject(schema.additionalProperties)
      ? check(schema.additionalProperties, item, childPath(path, key))
      : item;
  }
  for (const [key, propertySchema] of Object.entries(properties)) {
    const checked = check(propertySchema, value[key], childPath(path, key));
    if (checked !== undefined) result[key] = checked;
  }
  return result;
}

function checkArray(schema, value, path, label) {
  if (!Array.isArray(value)) throw new ToolError(`${label} must be an array.`);
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new ToolError(`${label} must contain at least ${schema.minItems} item(s).`);
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new ToolError(`${label} must contain at most ${schema.maxItems} item(s).`);
  }
  return schema.items ? value.map((item, index) => check(schema.items, item, `${path}[${index}]`)) : value;
}

function checkRange(schema, value, label) {
  const { minimum, maximum } = schema;
  if ((minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
    if (minimum !== undefined && maximum !== undefined) {
      throw new ToolError(`${label} must be between ${minimum} and ${maximum}.`);
    }
    throw new ToolError(minimum !== undefined ? `${label} must be at least ${minimum}.` : `${label} must be at most ${maximum}.`);
  }
}

function childPath(path, key) {
  return path ? `${path}.${key}` : key;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
