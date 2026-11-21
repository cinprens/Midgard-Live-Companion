import { describe, expect, it } from 'vitest';
import { aggregate, selectRecords } from './analytics';
import { demoRecords } from './demo';
describe('dashboard aggregation boundaries',()=>{
  it('excludes suspect overlapping sessions and unsupported records from every total',()=>{const [a,b,c]=demoRecords();b.overlapExcluded=true;c.status='unsupported';const result=aggregate([a,b,c]);expect(result.deaths).toBe(a.summary!.deaths);expect(result.included).toHaveLength(1);expect(result.monsters.reduce((n,m)=>n+m.deaths,0)).toBe(a.summary!.deaths);});
  it('keeps unknown EXP and drops unknown instead of claiming zero',()=>{const records=demoRecords();expect(aggregate(records).exp).toBeNull();expect(aggregate(records).drops).toBeNull();expect(aggregate([]).exp).toBeNull();});
  it('does not attribute undated replay deaths to its import date in daily statistics',()=>{const [r]=demoRecords();r.summary!.startedAt=null;expect(aggregate([r]).daily).toEqual([]);expect(aggregate([r]).deaths).toBe(r.summary!.deaths);});
  it('filters by recording time, preserving all-time undated records',()=>{const [r]=demoRecords();r.summary!.startedAt='2025-01-01T00:00:00Z';r.importedAt='2026-11-01T00:00:00Z';expect(selectRecords([r],7,Date.parse('2026-11-01T12:00:00Z'))).toHaveLength(0);r.summary!.startedAt=null;expect(selectRecords([r],7,Date.parse('2026-11-01T12:00:00Z'))).toHaveLength(1);expect(selectRecords([r],0)).toHaveLength(1);});
});
