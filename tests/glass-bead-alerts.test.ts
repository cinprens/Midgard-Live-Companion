import { describe, expect, it } from 'vitest';
import { GLASS_BEAD_ITEM_ID, NotificationEngine, createDefaultAlertPreferences, validateAlertPreferences } from '../src/domain/notifications';
import type { AlertPreferences, NotificationEvent, NotificationSnapshot } from '../src/domain/notifications';

const verifiedRaw = (timestamp:number,owner=42) => ({result:0,inventoryAction:'incoming',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventorySource:'unknown',inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:owner,before:60000,after:60010,receiptTimestamp:timestamp,weightTimestamp:timestamp+500,confirmedAt:timestamp+500,scope:'receipt-batch'}});
const bead = (timestamp: number, amount = 1, patch: Partial<NotificationEvent> = {}): NotificationEvent => ({
  id: `bead-${timestamp}`, timestamp, eventType: 'item-obtained', itemId: 746,
  amount, actorId: 42, packetId: '0x0a37', confidence: 'certain', rawData: verifiedRaw(timestamp), ...patch,
});
const snapshot = (events: readonly NotificationEvent[], patch: Partial<NotificationSnapshot> = {}): NotificationSnapshot => ({
  streamId: 'glass-a', recordingId: 'recording-a', character: 'QA Glass Bead', playerId: 42, events, ...patch,
});
const engine = (patch: Partial<AlertPreferences> = {}) => new NotificationEngine(validateAlertPreferences({
  selectedCardIds: [4317], enabled: { 'glass-bead': true }, ...patch,
}));

describe('Glass Bead as an ordinary item target', () => {
  it('leaves Glass Bead off by default and accepts it as an explicit item target', () => {
    expect(createDefaultAlertPreferences().enabled['glass-bead']).toBe(false);
    const value = new NotificationEngine(validateAlertPreferences({ selectedCardIds: [746] }));
    const fresh=new NotificationEngine(); fresh.observe(snapshot([])); expect(fresh.observe(snapshot([bead(1)]))).toEqual([]);
    value.observe(snapshot([])); expect(value.observe(snapshot([bead(1)]))[0]).toMatchObject({type:'card',itemId:746,subject:'Glass Bead'});
  });
  it('uses the locally confirmed item identity independently of the selected cards', () => {
    expect(GLASS_BEAD_ITEM_ID).toBe(746);
    const value = engine(); value.observe(snapshot([]));
    const alerts = value.observe(snapshot([bead(1)]));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'card', itemId: 746, amount: 1 });
    expect(alerts[0].message).toContain('Glass Bead çantaya geldi (1 adet). Kaynağı doğrulanmadı.');
    expect(value.getPreferences().selectedCardIds).toEqual([4317]);
  });

  it('silently baselines historical receipts and only sums newly observed amounts', () => {
    const value = engine(), history = [bead(10, 8), bead(20, 2)];
    expect(value.observe(snapshot(history))).toEqual([]);
    const events = [...history, bead(30, 1), bead(40, 3)];
    expect(value.observe(snapshot(events))).toEqual([expect.objectContaining({ type: 'card', amount: 4 })]);
    expect(value.observe(snapshot(events.map((event, index) => ({ ...event, id: `shifted-${index}` }))))).toEqual([]);
  });

  it('deduplicates repeated observations while retaining distinct identical packets at one timestamp', () => {
    const value = engine(); value.observe(snapshot([bead(1000)]));
    const events = [bead(1000), bead(1000, 1, { id: 'next-position' }), bead(1000, 1, { id: 'third-position' })];
    expect(value.observe(snapshot(events))[0]).toMatchObject({ type: 'card', amount: 2 });
    expect(value.observe(snapshot(events))).toEqual([]);
    expect(value.observe(snapshot(events.slice(0, 1)))).toEqual([]);
    expect(value.observe(snapshot(events))).toEqual([]);
  });

  it('does not replay a temporarily cut tail when it returns', () => {
    const value = engine(); value.observe(snapshot([bead(100)]));
    expect(value.observe(snapshot([bead(100), bead(200)]))).toHaveLength(1);
    expect(value.observe(snapshot([bead(100)]))).toEqual([]);
    expect(value.observe(snapshot([bead(100), bead(200)]))).toEqual([]);
    expect(value.observe(snapshot([bead(100), bead(200), bead(300)]))[0]?.amount).toBe(1);
  });

  it.each(['item-ground', 'drop', 'inventory-snapshot', 'inventory-ack', 'item-disappear'])('ignores %s rather than claiming an incoming item', eventType => {
    const value = engine(); value.observe(snapshot([]));
    expect(value.observe(snapshot([bead(1, 3, { eventType })]))).toEqual([]);
  });

  it('ignores failed, empty, malformed, initial-inventory and wrong-owner receipts', () => {
    const value = engine({ selectedCardIds: [4317, 746] }); value.observe(snapshot([]));
    const invalid = [
      bead(1, 0), bead(2, -1), bead(3, NaN), bead(4, 1.5), bead(5, 1, { actorId: 99 }),
      bead(6, 5, { rawData: { ...verifiedRaw(6),result: 6 } }), bead(7, 5, { rawData: { inventoryBaseline: true, result: 0 } }),
    ];
    expect(value.observe(snapshot(invalid))).toEqual([]);
    expect(value.observe(snapshot([...invalid, bead(8, 2)]))[0]).toMatchObject({ type: 'card', amount: 2 });
  });

  it('rejects a normalized inventory event when its owner is missing', () => {
    const value = engine(); value.observe(snapshot([]));
    expect(value.observe(snapshot([bead(1, 1, { actorId: undefined })]))).toEqual([]);
  });

  it('does not confuse neighboring item IDs with Glass Bead', () => {
    const value = engine(); value.observe(snapshot([]));
    expect(value.observe(snapshot([bead(1, 1, { itemId: 745 }), bead(2, 1, { itemId: 747 })]))).toEqual([]);
  });

  it('emits once per ordinary target when the old Glass Bead selection overlaps its ID', () => {
    const value = engine({ selectedCardIds: [4317, 746] }); value.observe(snapshot([]));
    const alerts = value.observe(snapshot([bead(1, 2), bead(2, 1, { itemId: 4317 })]));
    expect(alerts).toHaveLength(2);
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'card', itemId: 746, amount: 2 }),
      expect.objectContaining({ type: 'card', itemId: 4317, amount: 1 }),
    ]));
    expect(alerts.filter(alert=>alert.itemId===746)).toHaveLength(1);
  });

  it('uses the general item switch and never replays disabled history', () => {
    const value = engine({ selectedCardIds: [4317, 746] }); value.observe(snapshot([]));
    value.setPreferences({ enabled: { card: false } });
    const events = [bead(1)]; expect(value.observe(snapshot(events))).toEqual([]);
    value.setPreferences({ enabled: { card: true } });
    expect(value.observe(snapshot(events))).toEqual([]);
    expect(value.observe(snapshot([...events, bead(2)]))).toEqual([expect.objectContaining({ type: 'card', amount: 1 })]);
    value.setPreferences({ enabled: { card: false } });
    expect(value.observe(snapshot([...events, bead(2), bead(3)]))).toEqual([]);
  });

  it('retains visual notifications in mute mode and leaves audio suppression to the output layer', () => {
    const value = engine({ muted: true, volume: 31 }); value.observe(snapshot([]));
    expect(value.observe(snapshot([bead(1)]))[0]?.type).toBe('card');
    expect(value.getPreferences()).toMatchObject({ muted: true, volume: 31 });
  });

  it('silently baselines resets, new recordings, removal and a newly restarted engine', () => {
    const value = engine(); value.observe(snapshot([]));
    expect(value.observe(snapshot([bead(1)]))).toHaveLength(1);
    expect(value.observe(snapshot([bead(1)], { reset: true }))).toEqual([]);
    expect(value.observe(snapshot([bead(1), bead(2)]))).toHaveLength(1);
    expect(value.observe(snapshot([bead(1), bead(2)], { recordingId: 'recording-b' }))).toEqual([]);
    expect(value.observe(snapshot([bead(1), bead(2), bead(3)], { recordingId: 'recording-b' }))).toHaveLength(1);
    value.remove('glass-a'); expect(value.observe(snapshot([bead(1), bead(2)]))).toEqual([]);
    const restarted = new NotificationEngine(value.getPreferences());
    expect(restarted.observe(snapshot([bead(1), bead(2), bead(3)]))).toEqual([]);
    expect(restarted.observe(snapshot([bead(1), bead(2), bead(3), bead(4)]))).toHaveLength(1);
  });

  it('keeps simultaneous character streams independent', () => {
    const value = engine(); value.observe(snapshot([])); value.observe(snapshot([], { streamId: 'glass-b' }));
    expect(value.observe(snapshot([bead(1)]))[0]?.streamId).toBe('glass-a');
    expect(value.observe(snapshot([bead(1)], { streamId: 'glass-b' }))[0]?.streamId).toBe('glass-b');
    expect(value.observe(snapshot([bead(1)]))).toEqual([]);
  });

  it('keeps both item notifications in a bounded burst ahead of less urgent events', () => {
    const value = new NotificationEngine(validateAlertPreferences({ selectedCardIds: [4317], enabled: { 'glass-bead': true } }), { maxNotificationsPerSnapshot: 2 });
    value.observe(snapshot([]));
    const deaths = Array.from({ length: 20 }, (_, index) => ({ eventType: 'player-death', timestamp: index + 1, targetId: 42 }));
    const alerts = value.observe(snapshot([...deaths, bead(21), bead(22, 1, { itemId: 4317 })]));
    expect(alerts).toHaveLength(2); expect(alerts.map(alert => alert.type).sort()).toEqual(['card', 'card']);
  });
});
