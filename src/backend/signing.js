import { createHmac, timingSafeEqual } from 'node:crypto';

function digest(secret, eventId, rawBody, timestamp) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.`)
    .update(rawBody)
    .digest();
}

export function sign(secret, eventId, rawBody, timestampSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new TypeError('The signature timestamp must be a nonnegative integer.');
  }
  return `t=${timestampSeconds},v1=${digest(secret, eventId, rawBody, timestampSeconds).toString('hex')}`;
}

export function verify(secret, eventId, rawBody, signature, nowMs = Date.now()) {
  if (typeof signature !== 'string' || typeof eventId !== 'string' || !eventId || !Number.isFinite(nowMs)) return false;
  const match = /^t=(\d{1,13}),v1=([a-fA-F0-9]{64})$/.exec(signature);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp * 1000) > 300_000) return false;
  try {
    return timingSafeEqual(digest(secret, eventId, rawBody, timestamp), Buffer.from(match[2], 'hex'));
  } catch {
    return false;
  }
}
