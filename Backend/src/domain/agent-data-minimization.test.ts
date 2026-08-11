import { describe, expect, it } from 'vitest';
import { minimizeAgentContent, minimizeAgentProfile } from './agent-data-minimization.js';

describe('Agent data minimization', () => {
  it('removes direct identifiers and precise unit details while retaining route context', () => {
    const minimized = minimizeAgentContent('从赣州市章贡区长征大道18号3栋2单元502室去南昌，联系13812345678，身份证36070219900101123X');

    expect(minimized).toContain('赣州市章贡区长征大道');
    expect(minimized).toContain('去南昌');
    expect(minimized).not.toContain('13812345678');
    expect(minimized).not.toContain('36070219900101123X');
    expect(minimized).not.toContain('502室');
  });

  it('only keeps mobility fields required for planning', () => {
    const minimized = minimizeAgentProfile({
      mobility: { requireStepFree: true, minimumDoorWidthCm: 82, secretHabit: 'private' },
      interaction: { preferVoiceOutput: true },
      installationId: 'must-not-leak',
    });

    expect(minimized).toEqual({ mobility: { requireStepFree: true, minimumDoorWidthCm: 82 } });
    expect(JSON.stringify(minimized)).not.toContain('installationId');
    expect(JSON.stringify(minimized)).not.toContain('secretHabit');
    expect(JSON.stringify(minimized)).not.toContain('preferVoiceOutput');
  });

  it('removes Chinese-number building and room details', () => {
    const minimized = minimizeAgentContent('从红旗大道十八号三栋二单元五零二室出发去南昌');

    expect(minimized).toContain('红旗大道');
    expect(minimized).toContain('去南昌');
    expect(minimized).not.toContain('十八号');
    expect(minimized).not.toContain('五零二室');
  });

  it('removes common hyphenated residential room numbers without removing travel dates', () => {
    const minimized = minimizeAgentContent('2026-08-11 从阳光小区3-2-502去南昌');

    expect(minimized).toContain('2026-08-11');
    expect(minimized).toContain('阳光小区');
    expect(minimized).not.toContain('3-2-502');
  });

  it('removes spaced, hyphenated and country-prefixed mobile numbers without harming dates', () => {
    const minimized = minimizeAgentContent('日期2026-08-11，电话138-1234-5678、138 1234 5678或+86 13912345678，人数11');

    expect(minimized).toContain('2026-08-11');
    expect(minimized).toContain('人数11');
    expect(minimized).not.toContain('138-1234-5678');
    expect(minimized).not.toContain('138 1234 5678');
    expect(minimized).not.toContain('13912345678');
  });
});
