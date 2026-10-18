import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { PrinterService } from './service.js';
import { createServer } from './server.js';

const args = process.argv.slice(2);
const allowed = new Set(['--enable-mock-controls', '--enable-mock-camera', '--help']);
if (args.some((arg) => !allowed.has(arg))) {
  console.error('Unsupported option. Only --enable-mock-controls, --enable-mock-camera and --help are accepted. Hardware transport is unavailable.');
  process.exitCode = 2;
} else if (args.includes('--help')) {
  console.log('bambu-printer-mcp (mock only)\n\nUsage: node dist/src/cli.js [--enable-mock-controls] [--enable-mock-camera]\n\nDefault: read-only synthetic telemetry over MCP stdio. No real printer transport exists.');
} else {
  const service = new PrinterService(undefined, {
    enableMockControls: args.includes('--enable-mock-controls'),
    enableMockCamera: args.includes('--enable-mock-camera'),
  });
  const server = createServer(service);
  const transport = new StdioServerTransport();
  const close = () => { void server.close(); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  try {
    await server.connect(transport);
  } catch {
    console.error('MCP stdio startup failed.');
    process.exitCode = 1;
  }
}
