const res = await fetch('https://api.dhan.co/v2/marketfeed/quote', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json',
    'access-token': process.env.DHAN_ACCESS_TOKEN, 'client-id': process.env.DHAN_CLIENT_ID },
  body: JSON.stringify({ NSE_EQ: [1333] }), // HDFCBANK
});
console.log(res.status, JSON.stringify(await res.json(), null, 2));