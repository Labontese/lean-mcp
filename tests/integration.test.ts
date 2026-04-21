import { describe, it, expect } from 'vitest';
import { LeanMcpServer } from '../src/server.js';

describe('lean-mcp integration', () => {
  it('should construct server', () => {
    const server = new LeanMcpServer();
    expect(server).toBeDefined();
  });
});
