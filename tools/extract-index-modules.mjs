import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(rootDir, 'index.html');
const indexHtml = readFileSync(indexPath, 'utf8');
const args = new Set(process.argv.slice(2));

function lineNumberAt(offset) {
  return indexHtml.slice(0, offset).split(/\r?\n/).length;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'module';
}

function findModules() {
  const marker = /^\/\/ MODULE:\s*(.+)$/gm;
  const matches = [];
  let match;
  while ((match = marker.exec(indexHtml))) {
    matches.push({
      name: match[1].trim(),
      markerStart: match.index,
      bodyStart: match.index,
      line: lineNumberAt(match.index)
    });
  }
  return matches.map((mod, index) => {
    const next = matches[index + 1];
    const source = indexHtml.slice(mod.bodyStart, next ? next.markerStart : indexHtml.length).trimEnd() + '\n';
    const lineCount = source.split(/\r?\n/).length;
    return {
      ...mod,
      index,
      lineCount,
      source,
      fileName: `${String(index + 1).padStart(2, '0')}-${slugify(mod.name)}.js`
    };
  });
}

const modules = findModules();

if (!modules.length) {
  console.error('No // MODULE: markers found in index.html');
  process.exit(1);
}

if (args.has('--write')) {
  const outDir = path.join(rootDir, 'src', 'generated');
  mkdirSync(outDir, { recursive: true });
  for (const mod of modules) {
    const header = [
      '// Generated preview fragment from index.html.',
      '// Canonical deploy source is still the repository root index.html; do not edit generated fragments directly.',
      ''
    ].join('\n');
    writeFileSync(path.join(outDir, mod.fileName), header + mod.source, 'utf8');
  }
  console.log(`Wrote ${modules.length} module preview files to ${path.relative(rootDir, outDir)}`);
} else {
  const maxName = Math.max(...modules.map(m => m.name.length));
  for (const mod of modules) {
    console.log(
      `${String(mod.index + 1).padStart(2, '0')}  ${mod.name.padEnd(maxName)}  line ${String(mod.line).padStart(5)}  ${String(mod.lineCount).padStart(5)} lines`
    );
  }
  console.log(`\n${modules.length} module boundaries found. Use --write to generate preview fragments under src/generated/.`);
}
