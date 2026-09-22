import { describe, it, expect } from 'vitest';
import { withTrustedForwardedHeaders } from './forwarded-headers';

describe('withTrustedForwardedHeaders', () => {
  it('replaces client-supplied forwarded headers with CF-Connecting-IP', () => {
    const request = new Request('https://bot.example.com/chat', {
      headers: {
        'cf-connecting-ip': '203.0.113.7',
        'x-forwarded-for': '1.2.3.4, 5.6.7.8',
        'x-real-ip': '1.2.3.4',
        forwarded: 'for=1.2.3.4',
        'x-forwarded-proto': 'http',
        cookie: 'a=b',
      },
    });

    const headers = withTrustedForwardedHeaders(request).headers;

    expect(headers.get('x-forwarded-for')).toBe('203.0.113.7');
    expect(headers.get('x-forwarded-proto')).toBe('https');
    expect(headers.get('x-forwarded-host')).toBe('bot.example.com');
    expect(headers.has('x-real-ip')).toBe(false);
    expect(headers.has('forwarded')).toBe(false);
    expect(headers.get('cookie')).toBe('a=b');
  });

  it('drops forwarded headers entirely without CF-Connecting-IP', () => {
    const request = new Request('https://bot.example.com/', {
      headers: { 'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil.example' },
    });

    const headers = withTrustedForwardedHeaders(request).headers;

    expect(headers.has('x-forwarded-for')).toBe(false);
    expect(headers.has('x-forwarded-host')).toBe(false);
  });

  it('keeps the method and URL', () => {
    const proxied = withTrustedForwardedHeaders(
      new Request('https://bot.example.com/api?x=1', { method: 'POST', body: 'hi' }),
    );
    expect(proxied.method).toBe('POST');
    expect(proxied.url).toBe('https://bot.example.com/api?x=1');
  });
});
