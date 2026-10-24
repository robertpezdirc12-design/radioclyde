#!/usr/bin/env node
// Dry-run for producer/smartBlocks.js (P3 #14, LibreTime Smart Blocks) --
// prints exactly what a named block would schedule RIGHT NOW (same library,
// history and RNG as the real production run), no writes. The operator's
// answer to "what will this block play tonight?" before wiring it into any
// brief. Without a name it lists the configured blocks with their criteria,
// limit and order.
import { findSmartBlock, smartBlocksConfig, expandSmartBlock } from '../producer/smartBlocks.js';
import { parseArgs } from '../lib/args.js';
import { formatClock } from '../lib/format.js';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const name = args._?.[0] ?? args.name;

  if (!name) {
    const blocks = smartBlocksConfig();
    if (blocks.length === 0) {
      console.log('No smart blocks defined (config.smartBlocks). Example:');
      console.log('  "smartBlocks": [');
      console.log('    { "name": "friday-night-jazz", "criteria": { "genre": "Jazz", "excludeKeywords": ["live"] },');
      console.log('      "limit": { "count": 12 }, "order": "random" }');
      console.log('  ]');
      return;
    }
    console.log(`Smart blocks (${blocks.length}):`);
    for (const b of blocks) {
      console.log(`  ${b.name}  limit=${JSON.stringify(b.limit ?? null)} order=${b.order ?? 'random'}${b.overflow ? ' overflow' : ''}`);
      console.log(`    criteria: ${JSON.stringify(b.criteria ?? {})}`);
    }
    console.log('\nPreview one: previewSmartBlock.js <name>');
    return;
  }

  const block = findSmartBlock(name);
  if (!block) {
    const available = smartBlocksConfig().map((b) => b.name).join(', ') || '(none defined)';
    throw new Error(`No smart block named "${name}" (configured: ${available}).`);
  }

  const result = await expandSmartBlock(block);
  console.log(`Block: ${block.name}  order=${result.block.order}  limit=${JSON.stringify(result.block.limit)}${result.block.overflow ? '  overflow=on' : ''}`);
  console.log(`Pool size (after dedupe + recently-played exclusion + bans): ${result.poolSize}`);
  console.log(`Selected ${result.tracks.length} track(s)`);
  console.log(`Music time: ${formatClock(result.estimatedMusicMs)}${result.targetMs ? ` (limit ${formatClock(result.targetMs)})` : ''}`);
  if (result.shortfall) console.log(`SHORTFALL: ${result.shortfall.note}`);
  if (result.limitNote) console.log(`NOTE: ${result.limitNote}`);
  console.log('');
  result.tracks.forEach((t, i) => {
    console.log(
      `${String(i + 1).padStart(2, '0')}. ${t.artist} — ${t.title} (${t.album ?? 'no album'}, ${t.year ?? '????'}) [${formatClock(t.durationMs)}]`
    );
  });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
