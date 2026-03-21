import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true });
const validatorCache = new WeakMap();

export function validateOrThrow(schema, value, label) {
  let validate = validatorCache.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    validatorCache.set(schema, validate);
  }

  if (!validate(value)) {
    const details = ajv.errorsText(validate.errors, { separator: "\n" });
    throw new Error(`${label} failed schema validation:\n${details}`);
  }

  return value;
}
