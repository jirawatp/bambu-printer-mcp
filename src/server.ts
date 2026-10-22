import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { PrinterService, ServiceError } from './service.js';

const printerId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const readAnnotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
};

async function result(operation: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    const output = { result: await operation() };
    return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    const output = error instanceof ServiceError
      ? { code: error.code, message: error.message }
      : { code: 'INTERNAL_ERROR', message: 'Mock operation failed.' };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
  }
}

/** Local stdio MCP surface. No tool accepts device addresses, credentials or raw commands. */
export function createServer(service = new PrinterService()): McpServer {
  const server = new McpServer({ name: 'bambu-printer-mcp', version: '0.1.0' }, {
    instructions: 'This server is mock-only by default: all printers and camera data are synthetic. '
      + 'No hardware support is validated. If the operator started it with the LAN read-only flag, one extra printer, live-x2d, '
      + 'is a subscribe-only telemetry observation with an unverified contract and unknown nozzle mapping; it has no controls or camera. '
      + 'Discover capabilities before each operation. '
      + 'Action confirmations are simulator workflow checks, not proof of human approval.',
  });

  server.registerTool('list_printers', {
    description: 'List the five synthetic family fixtures, plus live-x2d only when the operator enabled the read-only LAN observation; no discovery.',
    inputSchema: z.strictObject({}), annotations: readAnnotations,
  }, () => result(() => service.listPrinters()));

  server.registerTool('get_printer_capabilities', {
    description: 'Discover current per-fixture, exact mock firmware and policy capabilities. Hardware is untested.',
    inputSchema: z.strictObject({ printerId }), annotations: readAnnotations,
  }, ({ printerId }) => result(() => service.getCapabilities(printerId)));

  server.registerTool('get_printer_status', {
    description: 'Read synthetic (or, for live-x2d, unverified read-only observed) state, progress percent, nozzle/bed Celsius and seconds remaining; missing data is null.',
    inputSchema: z.strictObject({ printerId }), annotations: readAnnotations,
  }, ({ printerId }) => result(() => service.getStatus(printerId)));

  server.registerTool('prepare_mock_action', {
    description: 'Prepare a simulator-only pause, cancel or print plan. Requires startup opt-in. '
      + 'Print accepts only demo-cube or demo-benchy. Review the returned target/job/revision before executing.',
    inputSchema: z.strictObject({
      printerId, action: z.enum(['pause', 'cancel', 'print']),
      artifactId: z.enum(['demo-cube', 'demo-benchy']).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, (input) => result(() => service.prepareAction(input)));

  server.registerTool('execute_mock_action', {
    description: 'Execute a one-use, unexpired, unchanged simulator plan after explicit client confirmation. '
      + 'Cannot reach physical hardware. The confirmed flag is not human authentication.',
    inputSchema: z.strictObject({ planId: z.string().min(1).max(128), confirmed: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, (input) => result(() => service.executeAction(input)));

  server.registerTool('get_mock_camera', {
    description: 'Return a synthetic camera placeholder only when mock camera access was enabled at startup.',
    inputSchema: z.strictObject({ printerId }), annotations: readAnnotations,
  }, ({ printerId }) => result(() => service.getCamera(printerId)));

  return server;
}
