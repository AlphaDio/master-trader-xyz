import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function pathExists(filePath) {
  return fs.existsSync(filePath);
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function tryReadJson(filePath, fallback = null) {
  if (!pathExists(filePath)) {
    return fallback;
  }

  return readJson(filePath);
}

export function writeText(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, value, "utf8");
}

export function readText(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
}

export function removePath(filePath) {
  if (pathExists(filePath)) {
    fs.rmSync(filePath, { recursive: true, force: true });
  }
}

export function readJsonEnv(name, fallback = {}) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Environment variable ${name} must contain valid JSON: ${error.message}`);
  }
}

export function readListEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return [];
  }

  return raw
    .split(/[,\r\n;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function readBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  if (/^(true|1|yes|on)$/i.test(raw)) {
    return true;
  }

  if (/^(false|0|no|off)$/i.test(raw)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean-like value.`);
}

export function readNumberEnv(name, fallback = null) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a finite number.`);
  }

  return value;
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeRunId(prefix = "run") {
  const safeTime = new Date().toISOString().replace(/[:.]/g, "-");
  const random = crypto.randomUUID().slice(0, 8);
  return `${prefix}-${safeTime}-${random}`;
}

export function makeId(prefix = "id") {
  return `${prefix}-${crypto.randomUUID().slice(0, 12)}`;
}

export function safeJsonStringify(value) {
  return JSON.stringify(value, null, 2);
}

export function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function setNestedValue(target, dotPath, value) {
  const parts = dotPath.split(".").filter(Boolean);
  if (parts.length === 0) {
    return target;
  }

  let current = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part];
  }

  current[parts.at(-1)] = value;
  return target;
}

export function getNestedValue(target, dotPath) {
  const parts = dotPath.split(".").filter(Boolean);
  let current = target;

  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function parseArgs(argv) {
  const positionals = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? next : true;

    if (value !== true) {
      index += 1;
    }

    if (flags[key] === undefined) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value);
    } else {
      flags[key] = [flags[key], value];
    }
  }

  return { positionals, flags };
}

export function relativePath(fromPath, toPath) {
  return path.relative(fromPath, toPath).replace(/\\/g, "/");
}

export function redactText(text, redactions) {
  if (!text) {
    return text;
  }

  let output = text;
  const uniqueValues = [...new Set(redactions.filter((value) => typeof value === "string" && value.trim().length > 0))];
  uniqueValues.sort((left, right) => right.length - left.length);

  for (const secretValue of uniqueValues) {
    output = output.split(secretValue).join("[REDACTED]");
  }

  return output;
}

export function redactValue(value, redactions) {
  if (typeof value === "string") {
    return redactText(value, redactions);
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactions));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, redactValue(nestedValue, redactions)])
    );
  }

  return value;
}
