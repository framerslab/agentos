/**
 * @fileoverview Skills engine — canonical runtime for SKILL.md prompt modules.
 *
 * This is the **canonical** home of the skills runtime engine. It provides:
 * - {@link SkillLoader} — file parsing, frontmatter extraction, directory loading
 * - {@link SkillRegistry} — runtime registry, filtering, snapshot building
 * - Path utilities — `resolveDefaultSkillsDirs()` for skill directory resolution
 *
 * **Ecosystem layout** (mirrors extensions):
 * ```
 * @framers/agentos/skills               ← Engine (this module)
 * @framers/agentos-skills               ← Content (88 curated SKILL.md files + registry.json)
 * @framers/agentos-skills-registry      ← Catalog SDK (query helpers, factory functions)
 * ```
 *
 * For curated skill content, depend on `@framers/agentos-skills`.
 * For the catalog SDK (searchSkills, SKILLS_CATALOG, etc.), depend on
 * `@framers/agentos-skills-registry`.
 *
 * @module @framers/agentos/skills
 */

export * from './types.js';
export * from './SkillLoader.js';
export { SkillRegistry, type SkillRegistryOptions } from './SkillRegistry.js';
export * from './paths.js';
