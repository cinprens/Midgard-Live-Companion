/** Projection of archived, parser-proven deaths; this remains an attacker estimate. */
export function ownDamageEventSql(alias = 'e'): string {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error('Geçersiz olay tablosu takma adı.');
  const proof = `${alias}.proof_json`;
  const field = (key: string) => `json_extract(${proof},'$.${key}')`;
  const legacy = `${field('ownership')}='exclusive-observed-attacker-estimate'
    AND ${field('death')}='vanish-kind-1' AND ${field('scope')}='replay-local'
    AND ${field('targetActorId')}=${alias}.target_id
    AND (${field('lifecycleId')}=${alias}.lifecycle_id OR ${field('legacyLifecycleId')}=${alias}.lifecycle_id OR ${field('incrementalLifecycleId')}=${alias}.lifecycle_id)
    AND json_type(${proof},'$.lastAttackTimestamp') IN ('integer','real')
    AND ${field('lastAttackTimestamp')}>=0
    AND ${alias}.event_ms-${field('lastAttackTimestamp')} BETWEEN 0 AND 10000`;
  // New events persist the stricter runtime check (including the player and attackers).
  // Legacy proofs were produced by the same parser's exclusive-attacker contract.
  return `(CASE WHEN json_valid(${proof}) THEN CASE
    WHEN json_type(${proof},'$.ownDamageAccepted') IS NOT NULL THEN json_type(${proof},'$.ownDamageAccepted')='true'
    ELSE (${legacy}) END ELSE 0 END)`;
}
