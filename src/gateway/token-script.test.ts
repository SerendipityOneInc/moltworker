import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildGatewayTokenScript,
  injectGatewayTokenScript,
  GATEWAY_TOKEN_SCRIPT_PATH,
} from './token-script';

const TAG = `<script src="${GATEWAY_TOKEN_SCRIPT_PATH}"></script>`;

describe('injectGatewayTokenScript', () => {
  it('inserts the script tag right after <head>', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    expect(injectGatewayTokenScript(html)).toBe(
      `<!doctype html><html><head>${TAG}<meta charset="utf-8"></head><body></body></html>`,
    );
  });

  it('handles <head> with attributes and uppercase', () => {
    expect(injectGatewayTokenScript('<HEAD lang="en"><title>x</title>')).toBe(
      `<HEAD lang="en">${TAG}<title>x</title>`,
    );
  });

  it('prepends the tag when there is no <head>', () => {
    expect(injectGatewayTokenScript('<p>hi</p>')).toBe(`${TAG}<p>hi</p>`);
  });
});

function createStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

describe('buildGatewayTokenScript', () => {
  interface FakeWindow {
    sessionStorage: Storage;
    location: { pathname: string; search: string; hash: string };
    history: { state: unknown; replaceState: (s: unknown, t: string, url: string) => void };
    replaced: string | null;
  }

  let win: FakeWindow;

  function run(token: string) {
    // oxlint-disable-next-line no-new-func -- evaluating the generated browser script
    new Function('window', 'location', 'history', buildGatewayTokenScript(token))(
      win,
      win.location,
      win.history,
    );
  }

  beforeEach(() => {
    win = {
      sessionStorage: createStorage(),
      location: { pathname: '/chat', search: '?session=main', hash: '' },
      history: {
        state: null,
        replaceState: (_s, _t, url) => {
          win.replaced = url;
        },
      },
      replaced: null,
    };
  });

  it('adds #token= when the tab has no stored token', () => {
    run('abc123');
    expect(win.replaced).toBe('/chat?session=main#token=abc123');
  });

  it('keeps other hash params', () => {
    win.location.hash = '#foo=bar';
    run('abc123');
    expect(win.replaced).toBe('/chat?session=main#foo=bar&token=abc123');
  });

  it('does nothing when the token is already stored for this tab', () => {
    win.sessionStorage = createStorage({
      'openclaw.control.token.v1:wss://moltbot.example.com': 'abc123',
    });
    run('abc123');
    expect(win.replaced).toBeNull();
  });

  it('replaces a stale stored token', () => {
    win.sessionStorage = createStorage({
      'openclaw.control.token.v1:wss://moltbot.example.com': 'old',
    });
    run('abc123');
    expect(win.replaced).toBe('/chat?session=main#token=abc123');
  });

  it('escapes the token so it cannot break out of the script', () => {
    const script = buildGatewayTokenScript('</script><script>alert(1)</script>');
    expect(script).not.toContain('</script>');
  });
});
