// dhan-instruments-peek.mjs
// Downloads Dhan's instrument list (a big CSV of every tradable instrument), saves it next to this
// file, and prints: the column names, the row count, and a few NSE rows for 3 stocks.
//
// Run:  node dhan-instruments-peek.mjs
// If the download fails, copy the CSV link from the "Instruments" page of the Dhan docs and run:
//   node dhan-instruments-peek.mjs "https://...the-link..."

import { writeFileSync } from 'node:fs';

const url = process.argv[2] || 'https://images.dhan.co/api-data/api-scrip-master.csv';
console.log('Downloading:', url);

const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed: HTTP ${res.status}. Copy the CSV link from the Instruments page of the docs and pass it as the argument.`);
  process.exit(1);
}
const text = await res.text();
writeFileSync('dhan-instruments.csv', text);

const lines = text.split(/\r?\n/).filter(Boolean);
console.log(`\nSaved dhan-instruments.csv  (${lines.length - 1} rows)`);
console.log('\n--- COLUMN NAMES (first line) ---');
console.log(lines[0]);

for (const word of ['HDFC BANK', 'TATA CONSULTANCY', 'RELIANCE INDUSTRIES']) {
  const hits = lines.filter((l) => l.toUpperCase().includes(word) && l.toUpperCase().includes('NSE')).slice(0, 4);
  console.log(`\n--- rows containing "${word}" (max 4) ---`);
  hits.forEach((h) => console.log(h.length > 300 ? h.slice(0, 300) + '…' : h));
  if (!hits.length) console.log('(none found)');
}
