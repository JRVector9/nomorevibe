import { describe, expect, it, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn(), insert: vi.fn(), values: vi.fn(), audit: vi.fn(), writer: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: mocks.transaction } }));
vi.mock('@/lib/operations/admin-log', () => ({ adminAuditRow: mocks.audit }));
vi.mock('@/lib/operations/dr/epoch', () => ({ writerSiteActive: mocks.writer }));
import { saveKoreanDiscoveryControl } from '@/lib/crawl/korean-discovery/control';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.writer.mockResolvedValue(true);
  mocks.transaction.mockImplementation((run: (tx: unknown) => Promise<unknown>) => run({ execute: mocks.execute, insert: mocks.insert }));
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue({ actor: 'operator', action: 'korean-discovery-control' });
});

describe('audited Korean discovery control', () => {
  it('saves initial configuration and its audit in the same transaction', async () => {
    mocks.execute.mockResolvedValueOnce([{ enabled: false, epoch: 1, startAt: null }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await expect(saveKoreanDiscoveryControl({ enabled: true, startAt: '2026-01-01T00:00:00Z', epoch: 1 }, 'operator')).resolves.toEqual({ enabled: true });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith('operator', expect.objectContaining({ action: 'korean-discovery-control' }));
    expect(mocks.values).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale control epoch before updating or auditing', async () => {
    mocks.execute.mockResolvedValueOnce([{ enabled: false, epoch: 2, startAt: null }]);
    await expect(saveKoreanDiscoveryControl({ enabled: false, startAt: null, epoch: 1 }, 'operator')).rejects.toThrow('korean_settings_changed');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('preserves existing cursor history by refusing a changed start date once queries exist', async () => {
    mocks.execute.mockResolvedValueOnce([{ enabled: false, epoch: 2, startAt: '2026-01-01T00:00:00Z' }]).mockResolvedValueOnce([{ label: '한국어 README' }]);
    await expect(saveKoreanDiscoveryControl({ enabled: true, startAt: '2025-01-01T00:00:00Z', epoch: 2 }, 'operator')).rejects.toThrow('korean_history_already_started');
    expect(mocks.execute).toHaveBeenCalledTimes(2);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it('requires a start date for enabled discovery and a writable site', async () => {
    await expect(saveKoreanDiscoveryControl({ enabled: true, startAt: null, epoch: 1 }, 'operator')).rejects.toThrow('korean_history_start_missing');
    mocks.writer.mockResolvedValue(false);
    await expect(saveKoreanDiscoveryControl({ enabled: false, startAt: null, epoch: 1 }, 'operator')).rejects.toThrow('site_fenced');
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
