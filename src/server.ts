import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

export class LeanMcpServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      { name: 'lean-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('lean-mcp server running');
  }
}
