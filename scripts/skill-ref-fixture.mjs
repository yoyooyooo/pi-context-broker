import { skillRefProtocol } from '../packages/context-broker/src/skill-ref-protocol.ts';
import { parseNativeReference, nativeFileRef, hasExactNativeOwner, bindNativeReference, nativeReferenceLibrary } from '../packages/context-broker/src/native-reference.ts';

export const nativeReferenceSettings = { parseNativeReference, nativeFileRef, hasExactNativeOwner, bindNativeReference, nativeReferenceLibrary };

// Fixtures use the same selected, hash-checked protocol as the running Broker.
export function skillIdentity(libraryId, skillId) {
  return skillRefProtocol().formatSkillIdentity({ libraryId, skillId });
}

export function skillFileRef(identity, path, snapshot) {
  const protocol = skillRefProtocol();
  return protocol.formatSkillRef({
    owner: protocol.parseSkillIdentity(identity),
    path,
    selection: snapshot === undefined ? { kind: 'current' } : { kind: 'fixed', snapshotId: snapshot },
  });
}

export function pinSkillRef(reference, snapshot) {
  const protocol = skillRefProtocol();
  const bound = protocol.bindSkillRef(protocol.parseSkillRef(reference));
  return protocol.formatSkillRef({ ...bound, selection: { kind: 'fixed', snapshotId: snapshot } });
}
