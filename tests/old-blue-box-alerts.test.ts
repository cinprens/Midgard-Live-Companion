import { describe, expect, it } from 'vitest';
import { OLD_BLUE_BOX_ITEM_ID, NotificationEngine, createDefaultAlertPreferences, validateAlertPreferences } from '../src/domain/notifications';
import type { NotificationEvent, NotificationSnapshot } from '../src/domain/notifications';

const verifiedRaw = (timestamp:number,owner=42) => ({result:0,inventoryAction:'incoming',parserProof:'source-defined-add-delta',quantitySemantics:'added-delta',inventoryBaseline:false,inventorySource:'unknown',inventoryWeightProof:{kind:'own-weight-increase',ownerActorId:owner,before:60000,after:60010,receiptTimestamp:timestamp,weightTimestamp:timestamp+500,confirmedAt:timestamp+500,scope:'receipt-batch'}});
const box = (timestamp: number, amount = 1, patch: Partial<NotificationEvent> = {}): NotificationEvent => ({
  timestamp, eventType: 'item-obtained', itemId: 603, actorId: 42, amount,
  confidence: 'certain', rawData: verifiedRaw(timestamp), ...patch,
});
const snapshot = (events: readonly NotificationEvent[], patch: Partial<NotificationSnapshot> = {}): NotificationSnapshot => ({
  streamId: 'box-a', recordingId: 'recording-a', character: 'QA Old Blue Box', playerId: 42, events, ...patch,
});
const engine = () => new NotificationEngine(validateAlertPreferences({ selectedCardIds: [4317, 603] }));

describe('dedicated Old Blue Box inventory notification', () => {
  it('enables the confirmed item 603 by default while leaving Glass Bead disabled', () => {
    expect(OLD_BLUE_BOX_ITEM_ID).toBe(603);
    expect(createDefaultAlertPreferences().enabled).toMatchObject({ 'old-blue-box': true, 'glass-bead': false });
    const value = engine(); value.observe(snapshot([]));
    expect(value.observe(snapshot([box(1)]))).toEqual([expect.objectContaining({ type: 'old-blue-box', itemId: 603, amount: 1 })]);
  });

  it('baselines history and separately aggregates new boxes without counting beads or duplicating selected cards', () => {
    const value = engine(), history = [box(10, 8)]; expect(value.observe(snapshot(history))).toEqual([]);
    const events = [...history, box(20, 2), box(30, 3), box(40, 9, { itemId: 746 }), box(50, 1, { itemId: 4317 })];
    const alerts = value.observe(snapshot(events));
    expect(alerts).toHaveLength(2);
    expect(alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'old-blue-box', itemId: 603, amount: 5 }),
      expect.objectContaining({ type: 'card', itemId: 4317, amount: 1 }),
    ]));
    expect(alerts.find(alert => alert.type === 'old-blue-box')?.message).toContain('Old Blue Box çantaya geldi (5 adet). Kaynağı doğrulanmadı.');
    expect(value.observe(snapshot(events))).toEqual([]);
  });

  it('rejects ground, initial inventory, failed, zero, invalid and wrong-owner item observations', () => {
    const value = engine(); value.observe(snapshot([]));
    expect(value.observe(snapshot([
      box(1, 1, { eventType: 'item-ground' }), box(2, 1, { eventType: 'inventory-snapshot' }),
      box(3, 1, { rawData: { inventoryBaseline: true } }), box(4, 2, { rawData: { result: 6 } }),
      box(5, 0), box(6, -1), box(7, NaN), box(8, 1.5), box(9, 1, { actorId: 99 }),
      box(10, 1, { itemId: 602 }), box(11, 1, { itemId: 604 }),
    ]))).toEqual([]);
  });

  it('counts distinct same-timestamp packets once and never replays a shortened tail', () => {
    const value = engine(); value.observe(snapshot([box(100)]));
    const events = [box(100), box(100), box(100)];
    expect(value.observe(snapshot(events))[0]?.amount).toBe(2);
    expect(value.observe(snapshot([box(100)]))).toEqual([]);
    expect(value.observe(snapshot(events))).toEqual([]);
    expect(value.observe(snapshot([...events, box(200)]))[0]?.amount).toBe(1);
    expect(value.observe(snapshot(events))).toEqual([]);
    expect(value.observe(snapshot([...events, box(200)]))).toEqual([]);
  });

  it('baselines reset, new recording and restart without replaying old boxes', () => {
    const value = engine(); value.observe(snapshot([])); expect(value.observe(snapshot([box(1)]))).toHaveLength(1);
    expect(value.observe(snapshot([box(1)], { reset: true }))).toEqual([]);
    expect(value.observe(snapshot([box(1), box(2)], { recordingId: 'new-recording' }))).toEqual([]);
    expect(value.observe(snapshot([box(1), box(2), box(3)], { recordingId: 'new-recording' }))).toHaveLength(1);
    const restarted = new NotificationEngine(value.getPreferences());
    expect(restarted.observe(snapshot([box(1), box(2), box(3)]))).toEqual([]);
    expect(restarted.observe(snapshot([box(1), box(2), box(3), box(4)]))).toHaveLength(1);
  });

  it('keeps the box switch independent and suppresses the selected-card fallback while disabled', () => {
    const value = engine(); value.observe(snapshot([]));
    value.setPreferences({ enabled: { 'old-blue-box': false, 'glass-bead': true } });
    const events = [box(1), box(2, 1, { itemId: 746 })];
    expect(value.observe(snapshot(events)).map(alert => alert.type)).toEqual(['card']);
    value.setPreferences({ enabled: { 'old-blue-box': true, 'glass-bead': false } });
    expect(value.observe(snapshot(events))).toEqual([]);
    expect(value.observe(snapshot([...events, box(3)]))).toEqual([expect.objectContaining({ type: 'old-blue-box' })]);
  });

  it('keeps visual box events in mute mode without changing existing preferences', () => {
    const prefs = validateAlertPreferences({ muted: true, volume: 31, weightThreshold: 67, selectedCardIds: [4317] });
    const value = new NotificationEngine(prefs); value.observe(snapshot([]));
    expect(value.observe(snapshot([box(1)]))[0]?.type).toBe('old-blue-box');
    expect(value.getPreferences()).toMatchObject({ muted: true, volume: 31, weightThreshold: 67, selectedCardIds: [4317] });
  });

  it('preserves an explicit saved box preference and keeps independent stream baselines', () => {
    const prefs = validateAlertPreferences({ enabled: { 'old-blue-box': false }, selectedCardIds: [4317], volume: 24 });
    expect(validateAlertPreferences(prefs).enabled['old-blue-box']).toBe(false);
    const value = engine(); value.observe(snapshot([])); value.observe(snapshot([], { streamId: 'box-b' }));
    expect(value.observe(snapshot([box(1)]))[0]?.streamId).toBe('box-a');
    expect(value.observe(snapshot([box(1)], { streamId: 'box-b' }))[0]?.streamId).toBe('box-b');
    expect(value.observe(snapshot([box(1)]))).toEqual([]);
  });

  it('retains distinct card, bead and box alerts ahead of less urgent events in a bounded burst', () => {
    const value = new NotificationEngine(validateAlertPreferences({ selectedCardIds: [4317], enabled: { 'glass-bead': true } }), { maxNotificationsPerSnapshot: 3 });
    value.observe(snapshot([]));
    const deaths = Array.from({ length: 20 }, (_, index) => ({ eventType: 'player-death', timestamp: index + 1, targetId: 42 }));
    const alerts = value.observe(snapshot([...deaths, box(21), box(22, 1, { itemId: 746 }), box(23, 1, { itemId: 4317 })]));
    expect(alerts).toHaveLength(3); expect(alerts.map(alert => alert.type).sort()).toEqual(['card', 'card', 'old-blue-box']);
  });
});
