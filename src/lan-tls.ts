import tls from 'node:tls';
import type { ChannelFactory } from './lan-session.js';

export type TlsConnect = typeof tls.connect;

/** OpenSSL / Node error codes that mean "the peer's certificate did not verify". */
const VERIFICATION_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * TLS channel with verification fixed on: only the supplied vendor CA is trusted (no system
 * roots), chain and hostname are verified with Node's default checker against the exact device
 * serial used as SNI, and the port comes from the caller's fixed target. There is deliberately
 * no option to relax any of this. Raw socket errors are reduced to a closed set of kinds; their
 * text, addresses and certificates are never forwarded.
 */
export function createTlsChannelFactory(tlsConnect: TlsConnect = tls.connect): ChannelFactory {
  return (target, handlers) => {
    const socket = tlsConnect({
      host: target.host,
      port: target.port,
      servername: target.serverName,
      ca: [target.caPem],
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
    let secure = false;
    socket.once('secureConnect', () => {
      secure = true;
      handlers.secure();
    });
    socket.on('data', (chunk: Buffer) => { handlers.data(chunk); });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (secure) handlers.failed('peer-closed');
      else handlers.failed(error.code !== undefined && VERIFICATION_CODES.has(error.code) ? 'tls-verify' : 'connect');
    });
    socket.on('close', () => { handlers.closed(); });
    return {
      write: (packet) => { socket.write(packet); },
      destroy: () => { socket.destroy(); },
    };
  };
}
