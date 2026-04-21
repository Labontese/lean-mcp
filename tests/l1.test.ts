import { describe, it, expect } from 'vitest';
import { LazyRegistry } from '../src/layers/l1-lazy-registry.js';

describe('L1 LazyRegistry', () => {
  it('should initialize', () => {
    const registry = new LazyRegistry();
    expect(registry).toBeDefined();
  });
});
