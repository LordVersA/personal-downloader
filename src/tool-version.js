// Keep build metadata out of the table; the full value remains in its tooltip.
export const toolVersion = (version) => String(version ?? "").match(/\d+(?:\.\d+)*/)?.[0] ?? "-";
