const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/;
/** PostgreSQL commit upper bounds must not be rounded down to JavaScript milliseconds. */
export function replayTimestampMicros(value: string): bigint {
  const match = timestamp.exec(value);
  if (!match) throw new Error("invalid_replay_artifact");
  return BigInt(Date.parse(`${match[1]}.000Z`)) * BigInt(1000) + BigInt(match[2].padEnd(6, "0"));
}
