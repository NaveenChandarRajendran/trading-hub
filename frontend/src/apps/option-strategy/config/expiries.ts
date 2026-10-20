// Expiry lists copied from nseindia.com (format DD-Mon-YYYY, exactly as the API expects).
// Past dates are hidden automatically. Add new dates here when NSE lists them.
export const SYMBOLS = [
  { label: 'Nifty', value: 'NIFTY' },
  { label: 'Bank Nifty', value: 'BANKNIFTY' },
] as const;

export const EXPIRIES: Record<string, string[]> = {
  NIFTY: [
    '19-Oct-2026', '27-Oct-2026', '03-Nov-2026', '09-Nov-2026', '17-Nov-2026', '23-Nov-2026',
    '29-Dec-2026', '30-Mar-2027', '29-Jun-2027', '28-Sep-2027', '28-Dec-2027', '27-Jun-2028',
    '26-Dec-2028', '26-Jun-2029', '24-Dec-2029', '25-Jun-2030', '31-Dec-2030', '24-Jun-2031',
  ],
  BANKNIFTY: ['27-Oct-2026', '23-Nov-2026', '29-Dec-2026', '30-Mar-2027', '29-Jun-2027', '28-Sep-2027'],
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const parse = (s: string) => {
  const [d, m, y] = s.split('-');
  return new Date(Number(y), MONTHS.indexOf(m), Number(d));
};

export function upcomingExpiries(symbol: string, today = new Date()): string[] {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return (EXPIRIES[symbol] ?? []).filter((e) => parse(e) >= start).sort((a, b) => +parse(a) - +parse(b));
}

export function buildOptionChainUrl(symbol: string, expiry: string): string {
  const params = new URLSearchParams({ type: 'Indices', symbol, expiry });
  return `https://www.nseindia.com/api/option-chain-v3?${params}`;
}
