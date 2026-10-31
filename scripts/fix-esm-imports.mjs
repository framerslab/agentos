#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.resolve(__dirname, '..', 'dist');
const SELF_PACKAGE_NAME = '@framers/agentos';

/**
 * The modules under `dirPath` whose relative imports need their file named: the compiled `.js` files, which Node
 * loads, and the `.d.ts` files beside them, which a consumer's TypeScript reads. Under NodeNext a declaration's
 * extensionless relative import resolves to nothing, so a consumer that skips library checks reads every type behind
 * it as `any`. `./foo.js` in a declaration resolves to `./foo.d.ts`.
 */
function collectModuleFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectModuleFiles(fullPath));
    } else if (entry.isFile() && (fullPath.endsWith('.js') || fullPath.endsWith('.d.ts'))) {
      files.push(fullPath);
    }
  }
  return files;
}

function resolveSpecifier(filePath, specifier) {
  if (specifier === SELF_PACKAGE_NAME || specifier.startsWith(`${SELF_PACKAGE_NAME}/`)) {
    const relativeExportPath =
      specifier === SELF_PACKAGE_NAME ? 'index' : specifier.slice(SELF_PACKAGE_NAME.length + 1);
    const targetCandidates = [
      path.resolve(distDir, `${relativeExportPath}.js`),
      path.resolve(distDir, relativeExportPath, 'index.js'),
    ];
    const targetPath = targetCandidates.find((candidate) => fs.existsSync(candidate));
    if (!targetPath) {
      return specifier;
    }

    let relativePath = path.relative(path.dirname(filePath), targetPath).replace(/\\/g, '/');
    if (!relativePath.startsWith('.')) {
      relativePath = `./${relativePath}`;
    }
    return relativePath;
  }

  if (!specifier.startsWith('.')) {
    return specifier;
  }

  const hasKnownExtension = /\.(?:[cm]?js|json|node)$/i.test(specifier);
  if (hasKnownExtension) {
    return specifier;
  }

  const baseDir = path.dirname(filePath);
  const asJs = path.resolve(baseDir, `${specifier}.js`);
  if (fs.existsSync(asJs)) {
    return `${specifier}.js`;
  }

  const asIndex = path.resolve(baseDir, specifier, 'index.js');
  if (fs.existsSync(asIndex)) {
    return `${specifier}/index.js`;
  }

  return specifier;
}

function rewriteSpecifiers(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  let modified = original;
  let changed = false;

  const patterns = [
    // Multi-line aware: `[\s\S]*?` matches anything including newlines, non-greedy, so
    // imports with destructuring across multiple lines (e.g. `import { A,\n B\n} from './X'`)
    // are caught. Anchored to start-of-line by `^` + `m` flag and terminated by the `from`
    // keyword before a quote.
    /(^\s*(?:import|export)\s[\s\S]*?from\s+['"])([^'"]+)(['"])/gm,
    /(import\(\s*['"])([^'"]+)(['"]\s*\))/g
  ];

  for (const pattern of patterns) {
    modified = modified.replace(pattern, (match, prefix, specifier, suffix) => {
      const rewritten = resolveSpecifier(filePath, specifier);
      if (rewritten !== specifier) {
        changed = true;
        return `${prefix}${rewritten}${suffix}`;
      }
      return match;
    });
  }

  if (changed) {
    fs.writeFileSync(filePath, modified, 'utf8');
  }
}

function copyIfPresent(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

/**
 * Walk the dist tree after rewriting and verify every static/dynamic relative
 * import, in a `.js` or a `.d.ts` file, has a resolvable extension. Catches the case where a previous build
 * left partial dist state (e.g. rimraf failed because another process held
 * files open) and the rewriter's regex didn't reach a stale file.
 *
 * Returns an array of {file, specifier, line} for each unfixed import.
 */
export function findUnfixedRelativeImports(distDir) {
  const issues = [];
  const moduleFiles = collectModuleFiles(distDir);
  const patterns = [
    /(^\s*(?:import|export)\s[\s\S]*?from\s+['"])([^'"]+)(['"])/gm,
    /(import\(\s*['"])([^'"]+)(['"]\s*\))/g,
  ];
  for (const file of moduleFiles) {
    const contents = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let m;
      while ((m = pattern.exec(contents)) !== null) {
        const specifier = m[2];
        if (!specifier.startsWith('.')) continue;
        if (/\.(?:[cm]?js|json|node)$/i.test(specifier)) continue;
        // Look up the file's line number for a useful error message.
        const lineNumber = contents.slice(0, m.index).split('\n').length;
        issues.push({ file, specifier, line: lineNumber });
      }
    }
  }
  return issues;
}

// Only run the main pipeline when invoked directly, not when this module is
// imported from a test or another script.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  if (!fs.existsSync(distDir)) {
    console.log('[agentos fix-esm-imports] dist directory missing; nothing to do.');
    process.exit(0);
  }

  const moduleFiles = collectModuleFiles(distDir);
  for (const file of moduleFiles) {
    rewriteSpecifiers(file);
  }

  const copiedExtensionSecrets = copyIfPresent(
    path.resolve(distDir, 'core', 'config', 'extension-secrets.json'),
    path.resolve(distDir, 'config', 'extension-secrets.json'),
  );

  console.log(`[agentos fix-esm-imports] Processed ${moduleFiles.length} files under ${distDir}.`);
  if (copiedExtensionSecrets) {
    console.log('[agentos fix-esm-imports] Mirrored extension-secrets.json into dist/config for public package exports.');
  }

  const unfixed = findUnfixedRelativeImports(distDir);
  if (unfixed.length > 0) {
    console.error(
      `[agentos fix-esm-imports] FAIL: ${unfixed.length} relative import${unfixed.length === 1 ? '' : 's'} ` +
      `in dist still missing a file extension. This usually means a previous build ` +
      `left partial state — try \`rm -rf dist && pnpm build\`.`,
    );
    for (const issue of unfixed.slice(0, 20)) {
      const rel = path.relative(distDir, issue.file);
      console.error(`  ${rel}:${issue.line}  ->  ${issue.specifier}`);
    }
    if (unfixed.length > 20) {
      console.error(`  …and ${unfixed.length - 20} more.`);
    }
    process.exit(1);
  }
}
