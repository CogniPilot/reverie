import { describe, expect, it } from 'vitest';
import { DockerPlanInitialReceipt } from '../src/docker-plan-install-data.js';
import { parseDockerPlanProtocol } from '../src/docker-plan-protocol.js';
describe('exact native plan protocol compatibility', () => {
  const fields = Object.keys(DockerPlanInitialReceipt.shape),
    value = { version: 1, purpose: 'reverie-plan-protocol-v1', protocol: 1, receiptFields: fields };
  it('requires the entire current19-field receipt contract', () => {
    expect(fields).toHaveLength(19);
    expect(() => parseDockerPlanProtocol(JSON.stringify(value) + '\n')).not.toThrow();
  });
  it.each(['old', 'missing', 'duplicate', 'unknown', 'extra', 'oversize'] as const)(
    'refuses %s ABI before source-stop authority',
    (change) => {
      const input = structuredClone(value);
      if (change === 'old') input.protocol = 0;
      if (change === 'missing') input.receiptFields.pop();
      if (change === 'duplicate') input.receiptFields[1] = input.receiptFields[0]!;
      if (change === 'unknown') input.receiptFields[1] = 'unknownReceipt';
      if (change === 'extra') Object.assign(input, { capable: true });
      const text = change === 'oversize' ? ' '.repeat(8193) : JSON.stringify(input);
      expect(() => parseDockerPlanProtocol(text)).toThrow('unavailable');
    }
  );
});
