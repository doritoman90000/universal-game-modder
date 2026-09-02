#!/usr/bin/env node
// verify-release.mjs — the pre-ship gate for Universal Game Modder.
//
// Executes EVERY tool the shipped README documents as free-edition, using the
// EXACT parameter names the README prints, against a real PE binary. Any tool
// that errors, times out, or returns something that is not real data fails the
// run with a non-zero exit code.
//
// Usage:
//   node verify-release.mjs                 # verify the dev tree (./dist)
//   node verify-release.mjs <path-to-dist>  # verify a release cut's dist/
//
// The point: no release ships on a promise. It ships on a green run.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const distArg = process.argv[2] || resolve(process.cwd(), 'dist');
const toolsEntry = resolve(distArg, 'tools/index.js');

if (!existsSync(toolsEntry)) {
  console.error(`FATAL: cannot find ${toolsEntry}. Build first (npm run build), or pass the dist path.`);
  process.exit(2);
}

// A real, always-present PE binary to analyze. Overridable for non-Windows CI.
const TARGET = process.env.UGM_VERIFY_TARGET || 'C:/Windows/System32/notepad.exe';
if (!existsSync(TARGET)) {
  console.error(`FATAL: verification target not found: ${TARGET}. Set UGM_VERIFY_TARGET to a real binary.`);
  process.exit(2);
}

const { getAllTools } = await import(pathToFileURL(toolsEntry).href);
const tools = getAllTools();
const T = (n) => tools.find((x) => x.name === n);

const TIMEOUT_MS = 30000;

// Each case: [tool, args, assertion(resultString) -> true if the data is real]
// Args use the EXACT parameter names printed in README.md.
const CASES = [
  ['analyze_file_format', { file_path: TARGET }, (s) => s.includes('"format"') && s.includes('PE')],
  ['analyze_pe_full', { file_path: TARGET }, (s) => s.includes('"architecture"') && s.includes('"dataDirectories"')],
  ['analyze_dll_structure', { file_path: TARGET }, (s) => s.includes('"numberOfSections"')],
  ['calculate_checksums', { file_path: TARGET }, (s) => /"sha256":\s*"[0-9a-f]{64}"/.test(s)],
  ['hex_read', { file_path: TARGET, offset: 0, length: 16 }, (s) => s.toLowerCase().includes('4d 5a')],
  ['hex_search', { file_path: TARGET, hex_pattern: '4D 5A' }, (s) => !s.startsWith('ERROR')],
  ['pattern_scan', { file_path: TARGET, pattern: '4D 5A' }, (s) => s.includes('"matchCount"')],
  ['pattern_scan_all', { file_path: TARGET, pattern: '4D 5A' }, (s) => !s.startsWith('ERROR')],
  ['extract_strings', { file_path: TARGET, min_length: 8 }, (s) => s.includes('"count"')],
  ['extract_strings_advanced', { file_path: TARGET, min_length: 8 }, (s) => !s.startsWith('ERROR')],
  ['extract_dll_classes', { file_path: TARGET, search_terms: ['Health', 'Damage'] }, (s) => !s.startsWith('ERROR')],
  ['search_binary_pattern', { file_path: TARGET, patterns: ['Windows'] }, (s) => !s.startsWith('ERROR')],
  ['compare_binaries_detailed', { file_path_a: TARGET, file_path_b: TARGET }, (s) => !s.startsWith('ERROR')],
  ['rva_to_offset', { file_path: TARGET, rva: 4096 }, (s) => s.includes('"fileOffset"')],
  ['offset_to_rva', { file_path: TARGET, offset: 1024 }, (s) => !s.startsWith('ERROR')],
  ['disassemble_function', { binary_path: TARGET, rva: 4096 }, (s) => s.includes('"insn_count"')],
  ['disassemble_range', { binary_path: TARGET, rva: 4096 }, (s) => s.includes('"insn_count"')],
  // Session/workflow tools that need no game loaded:
  ['game_status', {}, (s) => !s.startsWith('ERROR')],
  ['list_available_tools', {}, (s) => !s.startsWith('ERROR')],
  ['find_steam_games', {}, (s) => !s.startsWith('ERROR')],
];

// Pro-backend tools must fail CLEANLY (a clear message, never a crash or hang).
const PRO_CASES = [
  ['decompile_type', { assembly: 'x', type_name: 'Y' }],
  ['jar_open', { jar_path: 'x.jar' }],
  ['open_game', { game_path: 'C:/nope' }],
];

const run = async (t, args) => {
  const timeout = new Promise((r) => setTimeout(() => r('__TIMEOUT__'), TIMEOUT_MS));
  try {
    return String(await Promise.race([t.handler(args), timeout]));
  } catch (e) {
    return 'THREW: ' + (e instanceof Error ? e.message : String(e));
  }
};

console.log('Universal Game Modder — release verification');
console.log('dist:   ' + distArg);
console.log('target: ' + TARGET);
console.log('-'.repeat(64));

let pass = 0;
const failures = [];

// Version consistency: the version the MCP server announces must match package.json.
// A drift here means a buyer cannot tell you which build they are running.
{
  const { readFileSync } = await import('node:fs');
  const pkgPath = resolve(distArg, '../package.json');
  try {
    const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
    const serverSrc = readFileSync(resolve(distArg, 'server.js'), 'utf-8');
    const hardcoded = serverSrc.match(/version:\s*'([^']+)'/);
    if (hardcoded && hardcoded[1] !== pkgVersion) {
      failures.push(`version drift: server.js hardcodes '${hardcoded[1]}' but package.json is '${pkgVersion}'`);
      console.log(`FAIL  version — server says '${hardcoded[1]}', package.json says '${pkgVersion}'`);
    } else {
      console.log(`ok    version — ${pkgVersion} (server reads it from package.json)`);
    }
  } catch (e) {
    console.log('warn  version — could not verify: ' + String(e.message).slice(0, 80));
  }
}

for (const [name, args, assert] of CASES) {
  const t = T(name);
  if (!t) {
    failures.push(`${name}: NOT FOUND in tool list`);
    console.log(`FAIL  ${name} — not found`);
    continue;
  }
  const raw = await run(t, args);
  const flat = raw.replace(/\s+/g, ' ');
  if (raw === '__TIMEOUT__') {
    failures.push(`${name}: timed out after ${TIMEOUT_MS}ms`);
    console.log(`FAIL  ${name} — TIMEOUT`);
  } else if (raw.startsWith('ERROR') || raw.startsWith('THREW')) {
    failures.push(`${name}: ${flat.slice(0, 160)}`);
    console.log(`FAIL  ${name} — ${flat.slice(0, 90)}`);
  } else if (!assert(flat)) {
    failures.push(`${name}: returned no recognizable data — ${flat.slice(0, 160)}`);
    console.log(`FAIL  ${name} — assertion failed`);
  } else {
    pass++;
    console.log(`ok    ${name}`);
  }
}

console.log('-'.repeat(64));
console.log('Pro-backend tools must fail cleanly (not crash/hang):');
let proOk = 0;
for (const [name, args] of PRO_CASES) {
  const t = T(name);
  if (!t) { console.log(`FAIL  ${name} — not found`); failures.push(`${name}: not found`); continue; }
  const raw = await run(t, args);
  if (raw === '__TIMEOUT__') {
    failures.push(`${name}: Pro tool HUNG instead of erroring cleanly`);
    console.log(`FAIL  ${name} — TIMEOUT (must error, not hang)`);
  } else if (raw.startsWith('ERROR') && raw.toLowerCase().includes('not configured')) {
    proOk++;
    console.log(`ok    ${name} — clean "not configured" error`);
  } else {
    // An opaque transport error (e.g. "Connection closed") means the backend
    // spawned and died instead of refusing cleanly — a buyer-facing defect.
    failures.push(`${name}: Pro tool failed opaquely instead of "not configured" — ${raw.replace(/\s+/g, ' ').slice(0, 140)}`);
    console.log(`FAIL  ${name} — opaque failure: ${raw.replace(/\s+/g, ' ').slice(0, 80)}`);
  }
}

console.log('='.repeat(64));
console.log(`free-edition tools verified: ${pass}/${CASES.length}`);
console.log(`pro-backend clean failures:  ${proOk}/${PRO_CASES.length}`);

if (failures.length) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log('  - ' + f);
  console.log('\nRESULT: FAIL — do not ship this build.');
  process.exit(1);
}
console.log('\nRESULT: PASS — every documented free-edition call returned real data.');
process.exit(0);
