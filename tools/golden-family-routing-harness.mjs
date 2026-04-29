import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const golden = JSON.parse(readFileSync(path.join(rootDir, 'data', 'golden-family-routing-benchmarks.json'), 'utf8'));

function extractFunctionSource(name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(indexHtml);
  if (!match) throw new Error(`Missing function ${name} in index.html`);
  const openBrace = indexHtml.indexOf('{', match.index);
  if (openBrace < 0) throw new Error(`Missing body for ${name}`);
  let depth = 0;
  for (let i = openBrace; i < indexHtml.length; i++) {
    const ch = indexHtml[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return indexHtml.slice(match.index, i + 1);
    }
  }
  throw new Error(`Unclosed body for ${name}`);
}

const functionNames = [
  'annualizedPremium',
  'moneyNumber',
  'getPolicyAnnualPayout',
  'getPolicyMonthlyPayout',
  'normalizeTextKey',
  'normalizeCompactKey',
  'normalizePersonNameKey',
  'cleanPersonDisplayName',
  'personNameEquivalent',
  'personNameLikelyTypoVariant',
  'policyPersonKey',
  'policyHasExplicitPeopleConflict',
  'policyInsurerIdentity',
  'policyProductIdentity',
  'policyNumberIdentity',
  'policyAmountAnchors',
  'policiesLikelySamePolicy',
  'policyAmountAnchorMatchCount',
  'policiesSafeAutoDuplicate',
  'normalizePolicyKey',
  '_levenshtein'
];

const harnessSource = `
${functionNames.map(extractFunctionSource).join('\n\n')}
({
  annualizedPremium,
  getPolicyMonthlyPayout,
  personNameEquivalent,
  personNameLikelyTypoVariant,
  policiesLikelySamePolicy,
  policiesSafeAutoDuplicate
});
`;

const fns = vm.runInNewContext(harnessSource, {}, { filename: 'policylens-golden-functions.vm.js' });
const results = [];

function pass(name) {
  results.push({ name, status: 'pass' });
}

function fail(name, message) {
  results.push({ name, status: 'fail', message });
}

function assertCase(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(name, err?.message || String(err));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

const goldenIds = new Set((golden.cases || []).map(c => c.id));

assertCase('benchmark file loads expected seed cases', () => {
  [
    'family-dependent-page-owner-trace',
    'same-product-different-owner',
    'honorific-duplicate-owner',
    'mixed-owned-and-dependent-under-one-name',
    'application-family-dob-table'
  ].forEach(id => assert(goldenIds.has(id), `missing benchmark case ${id}`));
  assert((golden.metrics || []).includes('annual premium accuracy'), 'missing annual premium metric');
  assert((golden.metrics || []).includes('payout accuracy'), 'missing payout metric');
  assert((golden.metrics || []).includes('import success rate'), 'missing import success metric');
});

assertCase('owner routing accepts honorific variants', () => {
  assert(fns.personNameEquivalent('Mr Tng Teng Soo', 'Tng Teng Soo'), 'honorific owner variant did not match');
});

assertCase('owner grouping tolerates one-token OCR typo', () => {
  assert(fns.personNameLikelyTypoVariant('Tng Meng Kat', 'Tng Meng Kiat'), 'near-name OCR typo did not match');
});

assertCase('duplicate guard keeps same product for different family members separate', () => {
  const a = {
    id: 'a',
    insurer: 'Singlife',
    productName: 'Singlife Flexi Life Income II',
    policyOwner: 'Tng Meng Kiat',
    lifeInsured: 'Tng Meng Kiat',
    sumAssured: 25000
  };
  const b = {
    id: 'b',
    insurer: 'Singlife',
    productName: 'Singlife Flexi Life Income II',
    policyOwner: 'Tng Wen Xin',
    lifeInsured: 'Tng Wen Xin',
    sumAssured: 25000
  };
  assert(!fns.policiesLikelySamePolicy(a, b), 'same product and sum assured merged across different owners');
});

assertCase('duplicate guard merges same policy number with title-only owner differences', () => {
  const a = {
    insurer: 'Singlife',
    productName: 'Flexi Life Income II',
    policyNumber: 'SL-123456',
    policyOwner: 'Mr Tng Teng Soo',
    lifeInsured: 'Tng Teng Soo',
    sumAssured: 25000
  };
  const b = {
    insurer: 'Singlife',
    productName: 'Flexi Life Income II',
    policyNumber: 'SL123456',
    policyOwner: 'Tng Teng Soo',
    lifeInsured: 'Tng Teng Soo',
    sumAssured: 25000
  };
  assert(fns.policiesSafeAutoDuplicate(a, b), 'same policy number with title-only owner difference was not safe to merge');
});

assertCase('annual premium accuracy normalizes monthly premium', () => {
  assertEqual(fns.annualizedPremium({ annualPremium: 100, premFrequency: 'monthly' }), 1200, 'monthly premium annualization');
});

assertCase('payout accuracy combines illustrated annual payout and converts monthly', () => {
  const monthly = fns.getPolicyMonthlyPayout({
    annuityGuaranteedPayout: 12000,
    annuityNonGuaranteedPayout: 6000
  });
  assertEqual(monthly, 1500, 'monthly payout from guaranteed plus non-guaranteed annual payout');
});

const failed = results.filter(r => r.status === 'fail');
for (const result of results) {
  const prefix = result.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`${prefix} ${result.name}${result.message ? ` - ${result.message}` : ''}`);
}

if (failed.length) {
  console.error(`\n${failed.length} golden regression check(s) failed.`);
  process.exit(1);
}

console.log(`\n${results.length} golden regression checks passed.`);
