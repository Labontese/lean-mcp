import { describe, it, expect, beforeEach } from 'vitest';
import { LazyRegistry } from '../src/layers/l1-lazy-registry.js';
import type { ToolDefinition } from '../src/types/index.js';

const makeTool = (
  name: string,
  description: string,
  handler: ToolDefinition['handler'] = async () => ({ ok: true }),
): ToolDefinition => ({
  name,
  description,
  schema: {
    type: 'object',
    properties: { foo: { type: 'string' } },
    required: ['foo'],
  },
  handler,
});

describe('L1 LazyRegistry', () => {
  let registry: LazyRegistry;

  beforeEach(() => {
    registry = new LazyRegistry();
  });

  it('initialises with empty stats', () => {
    const stats = registry.getStats();
    expect(stats).toEqual({
      totalTools: 0,
      searchCalls: 0,
      describeCalls: 0,
      executeCalls: 0,
    });
  });

  describe('register + search', () => {
    beforeEach(() => {
      registry.register(makeTool('read_file', 'Read a file from disk'));
      registry.register(makeTool('write_file', 'Write bytes to disk'));
      registry.register(makeTool('list_dir', 'List directory contents'));
    });

    it('returns matches by name substring, case-insensitive', () => {
      const results = registry.search('FILE');
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name).sort()).toEqual(['read_file', 'write_file']);
    });

    it('returns matches by description substring', () => {
      const results = registry.search('directory');
      expect(results).toEqual([
        { name: 'list_dir', description: 'List directory contents' },
      ]);
    });

    it('omits the full schema from search results', () => {
      const results = registry.search('read');
      expect(results[0]).toEqual({
        name: 'read_file',
        description: 'Read a file from disk',
      });
      expect(results[0]).not.toHaveProperty('schema');
    });

    it('returns all tools for an empty query', () => {
      expect(registry.search('')).toHaveLength(3);
    });

    it('returns empty list for unknown query', () => {
      expect(registry.search('nonexistent-xyz')).toEqual([]);
    });
  });

  describe('describe', () => {
    it('returns the full definition including schema', () => {
      const tool = makeTool('read_file', 'Read a file from disk');
      registry.register(tool);
      const result = registry.describe('read_file');
      expect(result).not.toBeNull();
      expect(result?.name).toBe('read_file');
      expect(result?.schema).toEqual(tool.schema);
    });

    it('returns null for unknown tool names', () => {
      expect(registry.describe('nope')).toBeNull();
    });
  });

  describe('execute', () => {
    it('invokes the registered handler and returns its result', async () => {
      registry.register(
        makeTool('add', 'Add two numbers', async (args) => {
          const a = Number(args.a);
          const b = Number(args.b);
          return a + b;
        }),
      );
      const result = await registry.execute('add', { a: 2, b: 3 });
      expect(result).toBe(5);
    });

    it('throws for unknown tool names', async () => {
      await expect(registry.execute('ghost', {})).rejects.toThrow(/Unknown tool: ghost/);
    });

    it('propagates handler errors', async () => {
      registry.register(
        makeTool('boom', 'Always fails', async () => {
          throw new Error('handler exploded');
        }),
      );
      await expect(registry.execute('boom', {})).rejects.toThrow('handler exploded');
    });
  });

  describe('getStats', () => {
    it('counts each operation independently', async () => {
      registry.register(makeTool('a', 'first tool'));
      registry.register(makeTool('b', 'second tool'));

      registry.search('first');
      registry.search('second');
      registry.search('nothing');
      registry.describe('a');
      await registry.execute('a', {});

      expect(registry.getStats()).toEqual({
        totalTools: 2,
        searchCalls: 3,
        describeCalls: 1,
        executeCalls: 1,
      });
    });

    it('does not count register calls as search/describe/execute', () => {
      registry.register(makeTool('a', 'first tool'));
      registry.register(makeTool('b', 'second tool'));
      const stats = registry.getStats();
      expect(stats.totalTools).toBe(2);
      expect(stats.searchCalls).toBe(0);
      expect(stats.describeCalls).toBe(0);
      expect(stats.executeCalls).toBe(0);
    });
  });

  it('re-registering a tool with the same name replaces it', () => {
    registry.register(makeTool('x', 'v1'));
    registry.register(makeTool('x', 'v2'));
    expect(registry.describe('x')?.description).toBe('v2');
    expect(registry.getStats().totalTools).toBe(1);
  });
});
