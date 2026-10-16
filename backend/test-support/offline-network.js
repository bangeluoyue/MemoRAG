// Permit loopback HTTP fixtures, reject all other TCP connections during tests.
// No application modules or development .env are loaded here.
import net from "node:net";
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof first === "object" ? first.host : typeof args[1] === "string" ? args[1] : undefined;
  if (host && !["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("OFFLINE_TEST_EXTERNAL_NETWORK_BLOCKED");
  }
  return originalConnect.apply(this, args);
};
