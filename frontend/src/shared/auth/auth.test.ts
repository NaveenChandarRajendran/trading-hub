import { describe, expect, it } from 'vitest';
import { wsUrl } from '../api';
import { initials, openedFromFile } from './auth';

describe('login gate helpers', () => {
  it('knows a double-clicked file', () => {
    expect(openedFromFile('file:')).toBe(true);
    expect(openedFromFile('http:')).toBe(false);
  });
  it('makes initials', () => {
    expect(initials('Naveen')).toBe('N');
    expect(initials('  naveen  kumar ')).toBe('NK');
    expect(initials('')).toBe('?');
  });
});

describe('wsUrl', () => {
  it('uses the page host (same origin), wss on https', () => {
    expect(wsUrl('/ws/paper', '', { protocol: 'http:', host: '127.0.0.1:8000' })).toBe('ws://127.0.0.1:8000/ws/paper');
    expect(wsUrl('/ws/paper', '', { protocol: 'https:', host: 'hub.example.in' })).toBe('wss://hub.example.in/ws/paper');
  });
  it('follows VITE_API_BASE when set', () => {
    expect(wsUrl('/ws/scalper', 'http://10.0.0.5:8000', { protocol: 'http:', host: 'x' })).toBe('ws://10.0.0.5:8000/ws/scalper');
  });
});
