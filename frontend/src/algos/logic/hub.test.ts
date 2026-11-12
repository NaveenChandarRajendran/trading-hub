import { describe, expect, it } from 'vitest';
import { daysCsv, eventsCsv, money, parseField, presetRange, renderMarkdown, safeHref } from './hub';

describe('presetRange', () => {
  it('week starts Monday, month on the 1st, FY on 1 Apr', () => {
    expect(presetRange('week', '2026-11-12')).toEqual({ from: '2026-11-09', to: '2026-11-12' }); // Thu -> Mon
    expect(presetRange('week', '2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-09' });
    expect(presetRange('month', '2026-11-12')).toEqual({ from: '2026-11-01', to: '2026-11-12' });
    expect(presetRange('fy', '2026-11-12')).toEqual({ from: '2026-04-01', to: '2026-11-12' });
    expect(presetRange('fy', '2027-02-03')).toEqual({ from: '2026-04-01', to: '2027-02-03' });
    expect(presetRange('custom', '2026-11-12')).toBeNull();
  });
  it('last month crosses the year', () => {
    expect(presetRange('lastMonth', '2026-11-12')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('lastMonth', '2026-01-05')).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(presetRange('lastMonth', '2028-03-10')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('renderMarkdown is safe', () => {
  it('renders headings, tables and lists', () => {
    const html = renderMarkdown('# ORB\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n- two');
    expect(html).toContain('<h1');
    expect(html).toContain('<table>');
    expect(html).toContain('<li>one</li>');
  });
  it('escapes raw HTML, block and inline', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\nhi <img src=x onerror=alert(1)> there');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });
  it('drops javascript: links and images, keeps http links', () => {
    expect(renderMarkdown('[x](javascript:alert(1))')).not.toContain('href');
    expect(renderMarkdown('[x](JaVa\tScript:alert(1))')).not.toContain('href');
    expect(renderMarkdown('![p](https://evil/p.png)')).not.toContain('<img');
    const ok = renderMarkdown('[Dhan](https://docs.dhanhq.co/api/v2/)');
    expect(ok).toContain('href="https://docs.dhanhq.co/api/v2/"');
    expect(ok).toContain('rel="noopener noreferrer"');
  });
  it('safeHref', () => {
    expect(safeHref('#rules')).toBe('#rules');
    expect(safeHref('../adr/0011.md')).toBe('../adr/0011.md');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});

describe('parseField', () => {
  it('validates per kind', () => {
    expect(parseField('int', '3')).toEqual({ value: 3 });
    expect(parseField('int', '2.5')).toEqual({ error: 'a whole number' });
    expect(parseField('number', '0.35')).toEqual({ value: 0.35 });
    expect(parseField('number', '-1')).toEqual({ error: 'a number 0 or more' });
    expect(parseField('number', 'x')).toEqual({ error: 'a number' });
    expect(parseField('time', '09:45')).toEqual({ value: '09:45' });
    expect(parseField('time', '9:45')).toEqual({ error: 'a time like 09:45' });
    expect(parseField('list', 'ATM, 2ITM')).toEqual({ value: ['ATM', '2ITM'] });
  });
});

describe('csv + money', () => {
  it('builds files with raw numbers', () => {
    expect(daysCsv([{ date: '2026-11-12', realized: 1200, charges: 80.5, net: 1119.5, trades: 2, wins: 1, losses: 1 }]))
      .toBe('date,trades,wins,losses,realized,charges,net\n2026-11-12,2,1,1,1200,80.5,1119.5\n');
    expect(eventsCsv([{ id: 1, ts: '2026-11-12T09:50:11+05:30', type: 'entry', side: 'CE', scope: 'NIFTY', variant: '', setup: '', message: 'a, b' }]))
      .toContain('"a, b"');
  });
  it('money', () => {
    expect(money(1250.5)).toBe('+₹1,250.50');
    expect(money(-80)).toBe('−₹80.00');
    expect(money(0)).toBe('₹0.00');
    expect(money(null)).toBe('–');
  });
});

describe('settings fields', () => {
  it('bool and fixed fields', () => {
    expect(parseField('bool', 'false')).toEqual({ value: false });
    expect(parseField('bool', 'x')).toEqual({ error: 'on or off' });
    expect(parseField('text', 'B')).toEqual({ error: 'fixed' });
  });
});
