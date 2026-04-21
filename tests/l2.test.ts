import { describe, it, expect } from 'vitest';
import { SemanticDedup } from '../src/layers/l2-semantic-dedup.js';

describe('L2 SemanticDedup', () => {
  it('should initialize', () => {
    const dedup = new SemanticDedup();
    expect(dedup).toBeDefined();
  });
});
