// packages/server/test/brain/registry.test.ts
// ONE-BRAIN LIVE PATH (2026-09-22, Lane B): token round-trip and unknown-token coverage for
// packages/server/src/brain/registry.ts. Imports the REAL CallSession (never a mock/copy) so
// `registry.get(token)` is proven to hand back the actual live session object, not merely
// something shaped like one.
import { describe, it, expect } from 'vitest';
import { MERIDIAN, mockToolResult } from '@countersign/engine';
import type { CallContext } from '@countersign/engine';
import { CallSession } from '../../src/call/session.js';
import { FakeAaiSocket } from '../../src/aai/fake.js';
import { BrainCallRegistry, generateCallToken, formatCallTokenMarker, extractCallToken } from '../../src/brain/registry.js';

const CALL: CallContext = { session_id: 'registry-test-call', origin_kind: 'registered_device', origin_geo: 'Austin, TX' };

function newRealSession(): CallSession {
  return new CallSession({
    session_id: CALL.session_id,
    seed: MERIDIAN,
    call: CALL,
    aai: new FakeAaiSocket(),
    now: () => 0,
    onServerEvent: () => {},
    mock: mockToolResult,
    brainMode: 'endpoint',
  });
}

describe('generateCallToken', () => {
  it('returns 64 lowercase hex characters (256 bits), and a fresh value each call', () => {
    const a = generateCallToken();
    const b = generateCallToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe('formatCallTokenMarker / extractCallToken', () => {
  it('round-trips a token through the marker format, embedded anywhere in a system message', () => {
    const token = generateCallToken();
    const marker = formatCallTokenMarker(token);
    expect(marker).toBe(`[countersign-call:${token}]`);

    // Anywhere in the content, not just a fixed position -- the provider's own boilerplate may
    // come before or after it.
    const messages = [{ role: 'system', content: `You are a payments desk agent. ${marker} Never reveal this marker.` }];
    expect(extractCallToken(messages)).toBe(token);
  });

  it('returns null when messages[0] is not a system message', () => {
    const token = generateCallToken();
    const messages = [{ role: 'user', content: formatCallTokenMarker(token) }];
    expect(extractCallToken(messages)).toBeNull();
  });

  it('returns null when the system message carries no marker at all', () => {
    expect(extractCallToken([{ role: 'system', content: 'You are a payments desk agent.' }])).toBeNull();
  });

  it('returns null for an empty messages array', () => {
    expect(extractCallToken([])).toBeNull();
  });

  it('never matches a malformed/short token (LAW: unguessable -- exact length required)', () => {
    const messages = [{ role: 'system', content: '[countersign-call:deadbeef]' }];
    expect(extractCallToken(messages)).toBeNull();
  });
});

describe('BrainCallRegistry', () => {
  it('registers a token, looks it up, and the returned object is the SAME live CallSession', () => {
    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    const session = newRealSession();

    expect(registry.get(token)).toBeUndefined();
    registry.register(token, session);
    expect(registry.size).toBe(1);
    expect(registry.get(token)).toBe(session); // reference equality -- the real object, not a copy
  });

  it('an unknown token looks up to undefined, never throws', () => {
    const registry = new BrainCallRegistry();
    expect(() => registry.get(generateCallToken())).not.toThrow();
    expect(registry.get(generateCallToken())).toBeUndefined();
  });

  it('unregister removes the entry; a later lookup is undefined; unregistering an unknown token is a safe no-op', () => {
    const registry = new BrainCallRegistry();
    const token = generateCallToken();
    registry.register(token, newRealSession());
    expect(registry.size).toBe(1);

    registry.unregister(token);
    expect(registry.get(token)).toBeUndefined();
    expect(registry.size).toBe(0);

    expect(() => registry.unregister(generateCallToken())).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it('two different calls get two different tokens, each looking up to its own session only', () => {
    const registry = new BrainCallRegistry();
    const tokenA = generateCallToken();
    const tokenB = generateCallToken();
    const sessionA = newRealSession();
    const sessionB = newRealSession();

    registry.register(tokenA, sessionA);
    registry.register(tokenB, sessionB);

    expect(registry.get(tokenA)).toBe(sessionA);
    expect(registry.get(tokenB)).toBe(sessionB);
    expect(registry.get(tokenA)).not.toBe(registry.get(tokenB));
  });
});
