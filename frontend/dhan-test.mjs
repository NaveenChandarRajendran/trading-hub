// dhan-test.mjs  -  checks that your Dhan token + Data API subscription work.
// Run:  node --env-file=.env.local dhan-test.mjs
// .env.local (same folder, never share it):
//   DHAN_CLIENT_ID=your-client-id
//   DHAN_ACCESS_TOKEN=your-access-token

const clientId = process.env.DHAN_CLIENT_ID;
const token = process.env.DHAN_ACCESS_TOKEN;
if (!clientId || !token) {
  console.error('Missing DHAN_CLIENT_ID or DHAN_ACCESS_TOKEN. Create .env.local first.');
  process.exit(1);
}

// NSE_EQ security ids (1333 and 11536 appear in Dhan's own examples).
// Look up other stocks in Dhan's instrument master CSV (Instruments section of the docs).
const body = { NSE_EQ: [1333, 11536] };

async function call(path) {
  const res = await fetch(`https://api.dhan.co/v2${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'access-token': token,
      'client-id': clientId,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\n=== POST ${path}  ->  HTTP ${res.status} ===`);
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
  if (res.status === 401) console.log('Hint: token expired or wrong. Tokens last 24 hours; generate a new one.');
  if (res.status === 429) console.log('Hint: too many requests. Market quote allows 1 request per second.');
  return res.status;
}

await call('/marketfeed/ohlc');
await new Promise((r) => setTimeout(r, 1200)); // stay under 1 request per second
await call('/marketfeed/ltp');
