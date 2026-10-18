import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';

// Launches only this repository's compiled simulator, never a printer connection.
const client = new Client({ name: 'bambu-mock-demo', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/cli.js', import.meta.url))],
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log('MCP tools:', tools.tools.map((tool) => tool.name).join(', '));
  for (const [name, args] of [
    ['list_printers', {}],
    ['get_printer_capabilities', { printerId: 'mock-x2d' }],
    ['get_printer_status', { printerId: 'mock-x2d' }],
  ] as const) {
    const response = await client.callTool({ name, arguments: args });
    console.log(name, JSON.stringify(response.structuredContent, null, 2));
  }
} finally {
  await client.close();
  await transport.close();
}
