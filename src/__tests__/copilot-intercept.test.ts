import { describe, it, expect } from 'vitest';
import { extractHostname, extractPath, extractMethod, isCopilotDomain } from '../copilot-intercept';

describe('extractHostname', () => {
  it('extracts from a URL string', () => {
    expect(extractHostname(['https://api.githubcopilot.com/v1/completions'])).toBe('api.githubcopilot.com');
  });

  it('extracts from options object with hostname', () => {
    expect(extractHostname([{ hostname: 'api.githubcopilot.com', path: '/v1' }])).toBe('api.githubcopilot.com');
  });

  it('extracts from options object with host:port', () => {
    expect(extractHostname([{ host: 'api.githubcopilot.com:443', path: '/v1' }])).toBe('api.githubcopilot.com');
  });

  it('extracts from URL object', () => {
    const url = new URL('https://api.githubcopilot.com/v1/completions');
    expect(extractHostname([url])).toBe('api.githubcopilot.com');
  });

  it('prefers first URL-like argument', () => {
    expect(extractHostname([
      'https://api.githubcopilot.com/v1',
      { hostname: 'other.com' },
    ])).toBe('api.githubcopilot.com');
  });

  it('returns null for no recognizable arguments', () => {
    expect(extractHostname([42, null, undefined])).toBeNull();
  });

  it('returns null for empty args', () => {
    expect(extractHostname([])).toBeNull();
  });

  it('handles invalid URL strings gracefully', () => {
    expect(extractHostname(['not-a-url'])).toBeNull();
  });
});

describe('extractPath', () => {
  it('extracts from URL string', () => {
    expect(extractPath(['https://api.githubcopilot.com/v1/completions'])).toBe('/v1/completions');
  });

  it('extracts from options object', () => {
    expect(extractPath([{ path: '/chat/completions' }])).toBe('/chat/completions');
  });

  it('extracts from URL object', () => {
    const url = new URL('https://api.githubcopilot.com/v1/completions');
    expect(extractPath([url])).toBe('/v1/completions');
  });

  it('returns / as default', () => {
    expect(extractPath([42])).toBe('/');
  });
});

describe('extractMethod', () => {
  it('extracts from options object', () => {
    expect(extractMethod([{ method: 'POST' }])).toBe('POST');
  });

  it('defaults to GET', () => {
    expect(extractMethod([{ hostname: 'example.com' }])).toBe('GET');
  });

  it('skips URL objects', () => {
    const url = new URL('https://example.com');
    expect(extractMethod([url, { method: 'PUT' }])).toBe('PUT');
  });
});

describe('isCopilotDomain', () => {
  it('matches exact known domains', () => {
    expect(isCopilotDomain('api.githubcopilot.com')).toBe(true);
    expect(isCopilotDomain('api.individual.githubcopilot.com')).toBe(true);
    expect(isCopilotDomain('copilot-proxy.githubusercontent.com')).toBe(true);
    expect(isCopilotDomain('copilot.api.github.com')).toBe(true);
  });

  it('matches wildcard *.githubcopilot.com', () => {
    expect(isCopilotDomain('new-subdomain.githubcopilot.com')).toBe(true);
    expect(isCopilotDomain('enterprise.githubcopilot.com')).toBe(true);
  });

  it('matches copilot*.githubusercontent.com', () => {
    expect(isCopilotDomain('copilot-cdn.githubusercontent.com')).toBe(true);
  });

  it('rejects non-Copilot domains', () => {
    expect(isCopilotDomain('api.github.com')).toBe(false);
    expect(isCopilotDomain('api.openai.com')).toBe(false);
    expect(isCopilotDomain('google.com')).toBe(false);
    expect(isCopilotDomain('githubcopilot.com')).toBe(false); // bare domain, no subdomain
    expect(isCopilotDomain('evil.githubcopilot.com.attacker.com')).toBe(false);
  });

  it('rejects non-copilot githubusercontent.com subdomains', () => {
    expect(isCopilotDomain('avatars.githubusercontent.com')).toBe(false);
    expect(isCopilotDomain('raw.githubusercontent.com')).toBe(false);
  });
});
