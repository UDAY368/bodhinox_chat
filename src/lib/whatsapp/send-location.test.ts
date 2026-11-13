import { describe, expect, it } from 'vitest';
import { parseSendLocation, SendMessageError, validateSendMessageParams } from './send-message';

describe('parseSendLocation', () => {
  it('accepts coordinates in range with an optional name and address', () => {
    expect(parseSendLocation({ latitude: 17.41, longitude: 78.44, name: ' Store ', address: '' }))
      .toEqual({ latitude: 17.41, longitude: 78.44, name: 'Store', address: null });
    expect(parseSendLocation({ latitude: '-33.9', longitude: '151.2' }))
      .toEqual({ latitude: -33.9, longitude: 151.2, name: null, address: null });
  });

  it('refuses missing, out-of-range or oversized values', () => {
    expect(parseSendLocation(null)).toBeNull();
    expect(parseSendLocation({ latitude: 91, longitude: 0 })).toBeNull();
    expect(parseSendLocation({ latitude: 0, longitude: -181 })).toBeNull();
    expect(parseSendLocation({ latitude: Number.NaN, longitude: 0 })).toBeNull();
    expect(parseSendLocation({ latitude: 0, longitude: 0, name: 'x'.repeat(101) })).toBeNull();
    expect(parseSendLocation({ latitude: 0, longitude: 0, address: 5 })).toBeNull();
  });
});

describe('validateSendMessageParams: location', () => {
  it('needs a valid place before anything is touched', () => {
    expect(() => validateSendMessageParams({ messageType: 'location' })).toThrow(SendMessageError);
    expect(() => validateSendMessageParams({ messageType: 'location', location: { latitude: 100, longitude: 0 } })).toThrow(/latitude/);
    expect(() => validateSendMessageParams({ messageType: 'location', location: { latitude: 12.9, longitude: 77.5 } })).not.toThrow();
  });
});
