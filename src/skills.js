import fs from "node:fs";
import path from "node:path";
import { skillRecordSchema } from "./schemas.js";
import { validateOrThrow } from "./validation.js";
import { ensureDir, nowIso, pathExists, readJson, readText, removePath, slugify, writeJson, writeText } from "./utils.js";

export async function seedSkillsFromConfig(config) {
  const changes = [];

  for (const url of config.skillUrls) {
    const existing = findSkillBySource(config, url);
    if (existing) {
      changes.push(await refreshSkill(config, existing.id));
    } else {
      changes.push(await addSkillFromUrl(config, url));
    }
  }

  return changes;
}

export async function startupSyncSkills(config, options = {}) {
  const requiredSkillIds = normalizeRequiredSkillIds(options.requiredSkillIds);
  const seeded = options.fetchRemote === true
    ? await seedSkillsFromConfig(config)
    : [];
  const synchronized = syncInstalledSkills(config, { requiredSkillIds });

  return {
    seeded: seeded.map((skill) => skill.id),
    imported: synchronized.imported,
    updated: synchronized.updated
  };
}

export async function addSkillFromUrl(config, url, options = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch skill from ${url}: ${response.status} ${response.statusText}`);
  }

  const markdown = await response.text();
  return upsertSkill(config, {
    existingId: null,
    existingRecord: null,
    sourceType: "url",
    source: url,
    requestedName: options.name || null,
    markdown
  });
}

export function addSkillFromFile(config, filePath, options = {}) {
  const resolvedPath = path.resolve(filePath);
  if (!pathExists(resolvedPath)) {
    throw new Error(`Skill file not found: ${resolvedPath}`);
  }

  const markdown = readText(resolvedPath);
  return upsertSkill(config, {
    existingId: null,
    existingRecord: null,
    sourceType: "file",
    source: resolvedPath,
    requestedName: options.name || null,
    markdown
  });
}

export async function refreshSkill(config, skillId) {
  const skill = loadSkill(config, skillId);
  if (skill.source_type === "url") {
    const response = await fetch(skill.source);
    if (!response.ok) {
      throw new Error(`Failed to refresh skill from ${skill.source}: ${response.status} ${response.statusText}`);
    }

    return upsertSkill(config, {
      existingId: skill.id,
      existingRecord: skill,
      sourceType: skill.source_type,
      source: skill.source,
      requestedName: skill.name,
      markdown: await response.text()
    });
  }

  return upsertSkill(config, {
    existingId: skill.id,
    existingRecord: skill,
    sourceType: skill.source_type,
    source: skill.source,
    requestedName: skill.name,
    markdown: readText(skill.source)
  });
}

export function listSkills(config) {
  const skillsDir = path.join(config.stateDir, "skills");
  if (!pathExists(skillsDir)) {
    return [];
  }

  return fs
    .readdirSync(skillsDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .map((fileName) => readSkillRecord(path.join(skillsDir, fileName)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function loadSkill(config, skillId) {
  const filePath = path.join(config.stateDir, "skills", `${skillId}.json`);
  if (!pathExists(filePath)) {
    throw new Error(`Skill not found: ${skillId}`);
  }

  return readSkillRecord(filePath);
}

export function enableSkill(config, skillId) {
  return updateSkillStatus(config, skillId, "enabled");
}

export function disableSkill(config, skillId) {
  return updateSkillStatus(config, skillId, "disabled");
}

export function deleteSkill(config, skillId) {
  removePath(path.join(config.stateDir, "skills", `${skillId}.json`));
  removePath(path.join(config.stateDir, "skills", `${skillId}.md`));
}

export function resolveSkillsForRun(config, explicitSkillIds = []) {
  const skillIds = explicitSkillIds.length > 0
    ? explicitSkillIds
    : config.defaultSkillIds.length > 0
      ? config.defaultSkillIds
      : [];

  const skills = skillIds.map((skillId) => {
    const skill = loadSkill(config, skillId);
    if (skill.status !== "enabled") {
      throw new Error(`Skill is disabled and cannot be used: ${skillId}`);
    }
    return skill;
  });

  touchSkills(config, skills.map((skill) => skill.id));
  return skills;
}

export function listSkillTargets(config) {
  return config.skillTargets.map((target) => ({
    tool: target.tool,
    dir: target.dir,
    exists: pathExists(target.dir)
  }));
}

export function checkSkillInstallations(config, options = {}) {
  const skills = listSkills(config);
  const index = buildSkillInstallationIndex(skills);

  return discoverInstalledSkillPackages(config, { tools: options.tools, existingOnly: false }).map((target) => ({
    tool: target.tool,
    dir: target.dir,
    exists: target.exists,
    installed_skills: target.installed_skills.map((installedSkill) => ({
      ...installedSkill,
      registry_skill_id: resolveInstalledSkillMatch(index, target, installedSkill) || null
    }))
  }));
}

export function importSkillsFromTargets(config, options = {}) {
  const imported = [];
  const discoveredTargets = discoverInstalledSkillPackages(config, {
    tools: options.tools,
    existingOnly: true
  });

  for (const target of discoveredTargets) {
    for (const installedSkill of target.installed_skills) {
      const existing = findSkillForInstalledPackage(listSkills(config), target, installedSkill);
      if (existing) {
        imported.push(updateSkillFromInstalledPackage(config, existing, target, installedSkill));
        continue;
      }

      imported.push(createSkillFromInstalledPackage(config, target, installedSkill));
    }
  }

  return imported;
}

export function integrateSkillToTargets(config, skillId, options = {}) {
  const skill = loadSkill(config, skillId);
  const targets = options.tools && options.tools.length > 0
    ? selectSkillTargets(config, options.tools, { existingOnly: false })
    : selectSkillTargets(config, [], { existingOnly: options.allTargets !== true });

  if (targets.length === 0) {
    throw new Error("No skill targets selected. Use --tool or configure/create at least one detected skill directory.");
  }

  const integrations = targets.map((target) => installSkillToTarget(config, skillId, target, {
    force: options.force === true
  }));

  return integrations;
}

function syncInstalledSkills(config, { requiredSkillIds }) {
  const synchronizedAt = nowIso();
  const discoveredTargets = discoverInstalledSkillPackages(config, {
    tools: [],
    existingOnly: false
  });
  let skills = listSkills(config);
  const imported = [];
  const updated = [];
  const seenPackageKeys = new Set();

  for (const target of discoveredTargets) {
    for (const installedSkill of target.installed_skills) {
      seenPackageKeys.add(makeInstalledPackageKey(target.tool, installedSkill.package_dir));

      const existing = findSkillForInstalledPackage(skills, target, installedSkill);
      if (existing) {
        const next = mergeInstalledPackageIntoSkill(existing, target, installedSkill, synchronizedAt);
        if (didSkillChange(existing, next)) {
          persistSkill(config, next);
          skills = replaceSkill(skills, next);
          updated.push(next.id);
        }
        continue;
      }

      if (requiredSkillIds.has(installedSkill.name) && installedSkill.is_system === false) {
        const created = createSkillFromInstalledPackage(config, target, installedSkill, synchronizedAt);
        skills = replaceSkill(skills, created);
        imported.push(created.id);
      }
    }
  }

  for (const skill of skills) {
    const next = markMissingIntegrations(skill, seenPackageKeys, synchronizedAt);
    if (didSkillChange(skill, next)) {
      persistSkill(config, next);
      updated.push(next.id);
    }
  }

  return {
    imported: [...new Set(imported)],
    updated: [...new Set(updated)]
  };
}

function updateSkillStatus(config, skillId, status) {
  const skill = loadSkill(config, skillId);
  const updated = {
    ...skill,
    status,
    updated_at: nowIso()
  };

  persistSkill(config, updated);
  return updated;
}

function createSkillFromInstalledPackage(config, target, installedSkill, synchronizedAt = nowIso()) {
  const integration = buildIntegrationRecord(target, installedSkill, {
    mode: "detected_package",
    synchronizedAt
  });

  return upsertSkill(config, {
    existingId: null,
    existingRecord: null,
    sourceType: "file",
    source: installedSkill.skill_file,
    requestedName: installedSkill.name,
    markdown: readText(installedSkill.skill_file),
    integrations: [integration]
  });
}

function updateSkillFromInstalledPackage(config, existingSkill, target, installedSkill, synchronizedAt = nowIso()) {
  const next = mergeInstalledPackageIntoSkill(existingSkill, target, installedSkill, synchronizedAt);
  persistSkill(config, next);
  return next;
}

function mergeInstalledPackageIntoSkill(skill, target, installedSkill, synchronizedAt) {
  const shouldRefreshSource = skill.source_type === "file"
    && path.normalize(skill.source) === path.normalize(installedSkill.skill_file)
    && pathExists(installedSkill.skill_file);
  const markdown = shouldRefreshSource ? readText(installedSkill.skill_file) : skill.raw_markdown;
  const parsed = parseSkillMarkdown(markdown);
  const existingIntegration = skill.integrations.find((integration) => isSameIntegrationTarget(integration, target));
  const nextIntegration = buildIntegrationRecord(target, installedSkill, {
    mode: existingIntegration?.mode || "detected_package",
    synchronizedAt,
    installedAt: existingIntegration?.installed_at || synchronizedAt
  });

  return {
    ...skill,
    title: shouldRefreshSource ? parsed.title : skill.title,
    raw_markdown: markdown,
    summary: shouldRefreshSource ? parsed.summary : skill.summary,
    metadata: shouldRefreshSource ? parsed.metadata : skill.metadata,
    integrations: upsertIntegration(skill.integrations, nextIntegration),
    updated_at: shouldRefreshSource || integrationChanged(existingIntegration, nextIntegration)
      ? synchronizedAt
      : skill.updated_at
  };
}

function markMissingIntegrations(skill, seenPackageKeys, synchronizedAt) {
  let changed = false;
  const integrations = skill.integrations.map((integration) => {
    const key = makeInstalledPackageKey(integration.tool, integration.package_dir);
    if (seenPackageKeys.has(key)) {
      if (integration.last_checked_at !== synchronizedAt) {
        changed = true;
        return {
          ...integration,
          last_checked_at: synchronizedAt
        };
      }

      return integration;
    }

    if (integration.status === "missing" && integration.last_checked_at === synchronizedAt) {
      return integration;
    }

    changed = true;
    return {
      ...integration,
      status: "missing",
      last_checked_at: synchronizedAt
    };
  });

  return changed
    ? {
        ...skill,
        integrations,
        updated_at: synchronizedAt
      }
    : skill;
}

function upsertSkill(config, { existingId, existingRecord, sourceType, source, requestedName, markdown, integrations = null }) {
  const parsed = parseSkillMarkdown(markdown);
  const id = existingId || uniqueSkillId(config, requestedName || parsed.title || source);
  const record = {
    id,
    name: requestedName || parsed.title || id,
    source_type: sourceType,
    source,
    status: existingRecord?.status || "enabled",
    title: parsed.title,
    raw_markdown: markdown,
    summary: parsed.summary,
    metadata: parsed.metadata,
    integrations: normalizeIntegrations(integrations ?? existingRecord?.integrations ?? []),
    created_at: existingRecord?.created_at || nowIso(),
    updated_at: nowIso(),
    last_fetched_at: nowIso(),
    last_used_at: existingRecord?.last_used_at || null
  };

  persistSkill(config, record);
  return record;
}

function persistSkill(config, record) {
  const normalized = normalizeSkillRecord(record);
  validateOrThrow(skillRecordSchema, normalized, `Skill ${normalized.id}`);
  writeJson(path.join(config.stateDir, "skills", `${normalized.id}.json`), normalized);
  writeText(path.join(config.stateDir, "skills", `${normalized.id}.md`), normalized.raw_markdown);
}

function readSkillRecord(filePath) {
  return validateOrThrow(
    skillRecordSchema,
    normalizeSkillRecord(readJson(filePath)),
    `Skill ${path.basename(filePath, ".json")}`
  );
}

function normalizeSkillRecord(record) {
  return {
    ...record,
    integrations: normalizeIntegrations(record.integrations || [])
  };
}

function normalizeIntegrations(integrations) {
  return (Array.isArray(integrations) ? integrations : [])
    .map((integration) => ({
      tool: integration.tool,
      target_dir: path.resolve(integration.target_dir),
      package_dir: path.resolve(integration.package_dir),
      skill_file: path.resolve(integration.skill_file),
      mode: integration.mode || "detected_package",
      status: integration.status || "installed",
      installed_at: integration.installed_at || nowIso(),
      last_seen_at: integration.last_seen_at || integration.installed_at || nowIso(),
      last_checked_at: integration.last_checked_at || integration.last_seen_at || integration.installed_at || nowIso(),
      is_system: integration.is_system === true
    }))
    .sort((left, right) => `${left.tool}:${left.target_dir}`.localeCompare(`${right.tool}:${right.target_dir}`));
}

function findSkillBySource(config, source) {
  const normalizedSource = path.normalize(source);
  return listSkills(config).find((skill) => path.normalize(skill.source) === normalizedSource) || null;
}

function uniqueSkillId(config, name) {
  const baseId = slugify(name) || "skill";
  let nextId = baseId;
  let counter = 2;

  while (pathExists(path.join(config.stateDir, "skills", `${nextId}.json`))) {
    nextId = `${baseId}-${counter}`;
    counter += 1;
  }

  return nextId;
}

function parseSkillMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const titleLine = lines.find((line) => line.trim().startsWith("#"));
  const title = titleLine ? titleLine.replace(/^#+\s*/, "").trim() : "Untitled Skill";
  const summary = lines.find((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#");
  }) || title;

  return {
    title,
    summary,
    metadata: {
      detected_urls: [...new Set((markdown.match(/https?:\/\/[^\s)]+/g) || []).map(cleanUrl))],
      detected_actions: lines
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line))
        .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+\.\s+/, "").trim())
        .slice(0, 16),
      warnings: lines
        .map((line) => line.trim())
        .filter((line) => /warning|must|required|api.?key|shown only once|secret/i.test(line))
        .slice(0, 16)
    }
  };
}

function cleanUrl(url) {
  return url.replace(/[),.;]+$/, "");
}

function touchSkills(config, skillIds) {
  const touchedAt = nowIso();
  for (const skillId of skillIds) {
    const skill = loadSkill(config, skillId);
    persistSkill(config, {
      ...skill,
      last_used_at: touchedAt,
      updated_at: touchedAt
    });
  }
}

function selectSkillTargets(config, requestedTools = [], { existingOnly = false } = {}) {
  const normalizedTools = normalizeRequestedTools(requestedTools);
  const availableTargets = normalizedTools.length > 0
    ? normalizedTools.map((tool) => {
        const target = config.skillTargets.find((item) => item.tool === tool);
        if (!target) {
          throw new Error(`Unknown skill target: ${tool}`);
        }
        return target;
      })
    : config.skillTargets;

  return existingOnly
    ? availableTargets.filter((target) => pathExists(target.dir))
    : availableTargets;
}

function normalizeRequestedTools(requestedTools) {
  const values = Array.isArray(requestedTools) ? requestedTools : requestedTools ? [requestedTools] : [];
  return [...new Set(values
    .flatMap((value) => typeof value === "string" ? value.split(",") : [])
    .map((value) => slugify(value))
    .filter(Boolean))];
}

function normalizeRequiredSkillIds(requiredSkillIds) {
  return new Set((Array.isArray(requiredSkillIds) ? requiredSkillIds : [])
    .filter((value) => typeof value === "string" && value.trim().length > 0));
}

function discoverInstalledSkillPackages(config, options = {}) {
  return selectSkillTargets(config, options.tools, { existingOnly: options.existingOnly === true }).map((target) => ({
    tool: target.tool,
    dir: target.dir,
    exists: pathExists(target.dir),
    installed_skills: pathExists(target.dir)
      ? findSkillPackages(target.dir).map((pkg) => ({
          name: pkg.name,
          skill_file: pkg.skillFile,
          package_dir: pkg.dir,
          is_system: pkg.isSystem
        }))
      : []
  }));
}

function findSkillPackages(rootDir, depth = 0, maxDepth = 3) {
  if (!pathExists(rootDir) || depth > maxDepth) {
    return [];
  }

  const skillFile = detectSkillMarkdownFile(rootDir);
  if (skillFile) {
    return [{
      name: path.basename(rootDir),
      dir: rootDir,
      skillFile,
      isSystem: rootDir.split(path.sep).includes(".system")
    }];
  }

  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => findSkillPackages(path.join(rootDir, entry.name), depth + 1, maxDepth));
}

function detectSkillMarkdownFile(dirPath) {
  for (const fileName of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(dirPath, fileName);
    if (pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildSkillInstallationIndex(skills) {
  const bySource = new Map();
  const byPackage = new Map();
  const bySkillFile = new Map();

  for (const skill of skills) {
    bySource.set(path.normalize(skill.source), skill.id);
    for (const integration of skill.integrations) {
      byPackage.set(makeInstalledPackageKey(integration.tool, integration.package_dir), skill.id);
      bySkillFile.set(makeInstalledSkillFileKey(integration.tool, integration.skill_file), skill.id);
    }
  }

  return { bySource, byPackage, bySkillFile };
}

function resolveInstalledSkillMatch(index, target, installedSkill) {
  return index.bySource.get(path.normalize(installedSkill.skill_file))
    || index.byPackage.get(makeInstalledPackageKey(target.tool, installedSkill.package_dir))
    || index.bySkillFile.get(makeInstalledSkillFileKey(target.tool, installedSkill.skill_file))
    || null;
}

function findSkillForInstalledPackage(skills, target, installedSkill) {
  const index = buildSkillInstallationIndex(skills);
  const skillId = resolveInstalledSkillMatch(index, target, installedSkill);
  return skillId ? skills.find((skill) => skill.id === skillId) || null : null;
}

function installSkillToTarget(config, skillId, target, { force }) {
  const skill = loadSkill(config, skillId);
  ensureDir(target.dir);

  const targetDir = path.join(target.dir, skill.id);
  const sourceDir = getSkillPackageDir(skill);
  if (sourceDir && path.normalize(sourceDir) === path.normalize(targetDir)) {
    return persistSkillIntegration(config, skill, buildIntegrationRecord(target, {
      name: skill.id,
      package_dir: targetDir,
      skill_file: path.join(targetDir, "SKILL.md"),
      is_system: false
    }, {
      mode: "existing_package"
    }));
  }

  if (pathExists(targetDir)) {
    if (!force) {
      throw new Error(`Target skill directory already exists: ${targetDir}. Use --force to replace it.`);
    }

    removePath(targetDir);
  }

  if (sourceDir) {
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    return persistSkillIntegration(config, skill, buildIntegrationRecord(target, {
      name: skill.id,
      package_dir: targetDir,
      skill_file: detectSkillMarkdownFile(targetDir) || path.join(targetDir, "SKILL.md"),
      is_system: false
    }, {
      mode: "copied_package"
    }));
  }

  ensureDir(targetDir);
  writeText(path.join(targetDir, "SKILL.md"), skill.raw_markdown);
  return persistSkillIntegration(config, skill, buildIntegrationRecord(target, {
    name: skill.id,
    package_dir: targetDir,
    skill_file: path.join(targetDir, "SKILL.md"),
    is_system: false
  }, {
    mode: "wrote_markdown_only"
  }));
}

function persistSkillIntegration(config, skill, integration) {
  const next = {
    ...skill,
    integrations: upsertIntegration(skill.integrations, integration),
    updated_at: nowIso()
  };

  persistSkill(config, next);
  return {
    tool: integration.tool,
    dir: integration.package_dir,
    status: "integrated",
    mode: integration.mode
  };
}

function buildIntegrationRecord(target, installedSkill, options = {}) {
  const timestamp = options.synchronizedAt || nowIso();
  return {
    tool: target.tool,
    target_dir: path.resolve(target.dir),
    package_dir: path.resolve(installedSkill.package_dir),
    skill_file: path.resolve(installedSkill.skill_file),
    mode: options.mode || "detected_package",
    status: "installed",
    installed_at: options.installedAt || timestamp,
    last_seen_at: timestamp,
    last_checked_at: timestamp,
    is_system: installedSkill.is_system === true
  };
}

function upsertIntegration(integrations, nextIntegration) {
  const next = normalizeIntegrations(integrations);
  const index = next.findIndex((integration) => isSameIntegrationTarget(integration, nextIntegration));

  if (index === -1) {
    return normalizeIntegrations([...next, nextIntegration]);
  }

  next[index] = normalizeIntegrations([{
    ...next[index],
    ...nextIntegration
  }])[0];
  return normalizeIntegrations(next);
}

function isSameIntegrationTarget(integration, target) {
  return integration.tool === target.tool
    && path.normalize(integration.target_dir) === path.normalize(target.dir || target.target_dir);
}

function integrationChanged(current, next) {
  if (!current) {
    return true;
  }

  return JSON.stringify(current) !== JSON.stringify(next);
}

function didSkillChange(current, next) {
  return JSON.stringify(current) !== JSON.stringify(next);
}

function replaceSkill(skills, nextSkill) {
  const index = skills.findIndex((skill) => skill.id === nextSkill.id);
  if (index === -1) {
    return [...skills, nextSkill];
  }

  const next = [...skills];
  next[index] = nextSkill;
  return next;
}

function makeInstalledPackageKey(tool, packageDir) {
  return `${tool}::${path.normalize(packageDir)}`;
}

function makeInstalledSkillFileKey(tool, skillFile) {
  return `${tool}::${path.normalize(skillFile)}`;
}

function getSkillPackageDir(skill) {
  if (skill.source_type !== "file") {
    return null;
  }

  const skillFileName = path.basename(skill.source).toLowerCase();
  if (skillFileName !== "skill.md" || !pathExists(skill.source)) {
    return null;
  }

  return path.dirname(skill.source);
}
