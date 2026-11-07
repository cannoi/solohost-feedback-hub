import net from "node:net";

export function isLoopbackAddress(address) {
  const value = String(address || "").toLowerCase().split("%")[0];
  if (net.isIPv4(value)) return value.startsWith("127.");
  if (value === "::1") return true;
  const mappedIpv4 = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return Boolean(mappedIpv4 && net.isIPv4(mappedIpv4[1]) && mappedIpv4[1].startsWith("127."));
}
