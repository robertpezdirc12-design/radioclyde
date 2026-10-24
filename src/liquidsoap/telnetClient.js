// Minimal raw client for Liquidsoap's telnet command server (radio.liq
// enables it, bound to 127.0.0.1 only -- see that file's own comment).
// Liquidsoap's telnet protocol is plain text: one command per line, response
// terminated by a line containing exactly "END". No npm dependency needed
// for something this small.
//
// The exact command set a given Liquidsoap build actually supports has bitten
// this project before (radio.liq's fade.out()/crossfade() comments) --
// verify against the real running build (`telnet 127.0.0.1 <port>` + `help`)
// before wiring a new command to a UI button, don't assume from Liquidsoap's
// general docs.
import net from 'node:net';
import { config } from '../config/index.js';

const CONNECT_TIMEOUT_MS = 3_000;
const RESPONSE_TIMEOUT_MS = 5_000;

export function sendCommand(command) {
  // A command must be exactly one line: Liquidsoap's server splits on the
  // first newline-free token boundary, so a filename containing \n or \r
  // (requests.push/beds.push take file paths) would smuggle a second telnet
  // command onto the wire. Loopback-only, but rejecting here costs nothing.
  if (/[\n\r]/.test(command)) {
    return Promise.reject(new Error('Liquidsoap telnet command rejected: contains a newline.'));
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.liquidsoap.telnetHost,
      port: config.liquidsoap.telnetPort,
    });
    let buffer = '';
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return; // timer-vs-error-vs-close double-fire is noise, not a new outcome
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      settle(reject, new Error(`Liquidsoap telnet command "${command}" timed out.`));
    }, CONNECT_TIMEOUT_MS + RESPONSE_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(`${command}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (/(^|\n)END\r?\n?$/.test(buffer)) {
        socket.end('quit\n');
        settle(resolve, buffer.replace(/(^|\n)END\r?\n?$/, '').trim());
      }
    });
    socket.on('error', (err) => {
      settle(reject, err);
    });
    // The server closing the connection before "END" (restart, crash, telnet
    // server hiccup) previously left the promise hanging until the full 8 s
    // timer -- a stuck Skip/Force-Next button in the studio for no reason.
    socket.on('close', () => {
      settle(reject, new Error('Liquidsoap telnet connection closed before END.'));
    });
  });
}
